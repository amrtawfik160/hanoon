import { projectPolicySchema, type Job, type ProjectPolicy } from "../domain/models";
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  SendMessagePayload,
} from "./types";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MAX_CALLBACK_BYTES = 64;
const MAX_TELEGRAM_TEXT_LENGTH = 4_096;
const MAX_EVIDENCE_LENGTH = 3_500;

export type CallbackAction =
  | { type: "project"; jobId: string; alias: string }
  | { type: "start"; jobId: string }
  | { type: "cancel"; jobId: string }
  | { type: "retry"; jobId: string }
  | { type: "review"; jobId: string }
  | { type: "merge"; nonce: string };

export type ReviewView = {
  verdict?: string;
  findings?: readonly unknown[];
  summary?: string;
};

export type ValidationView = {
  name: string;
  command?: string | null;
  outcome: string;
  summary?: string;
};

export type CheckView = {
  name: string;
  outcome?: string;
  bucket?: string;
  summary?: string;
};

export type JobStatusContext = {
  project?: ProjectPolicy | null;
  bbAppBaseUrl?: string;
  prTitle?: string;
  pullRequest?: {
    title?: string;
    changedFiles?: number;
    additions?: number;
    deletions?: number;
  };
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  diffStat?: { changedFiles: number; additions: number; deletions: number };
  review?: ReviewView;
  validation?: readonly ValidationView[];
  checks?: readonly CheckView[];
  evidence?: string;
  approvalExpiresAt?: number | string | Date;
  mergeNonce?: string;
  ready?: boolean;
};

type ProjectRecord = ProjectPolicy | { policy: ProjectPolicy; version?: number };

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redact(value: string): string {
  return value
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{10,}\b/g, "[redacted]");
}

function displayText(value: unknown, maxLength: number): string {
  const text = redact(typeof value === "string" ? value : String(value ?? ""));
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function html(value: unknown, maxLength: number): string {
  const source = redact(typeof value === "string" ? value : String(value ?? ""));
  let result = "";
  for (const character of source) {
    const escaped = escapeHtml(character);
    if (result.length + escaped.length > maxLength) {
      return maxLength > 1 ? `${result.slice(0, maxLength - 1)}…` : result.slice(0, maxLength);
    }
    result += escaped;
  }
  return result;
}

function validJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

function assertJobId(jobId: string): void {
  if (!validJobId(jobId)) throw new TypeError("jobId must be a 22-character base64url id");
}

function assertCallbackLength(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_CALLBACK_BYTES) {
    throw new TypeError("Telegram callback data exceeds 64 bytes");
  }
}

export function encodeCallbackData(action: CallbackAction): string {
  let encoded: string;
  switch (action.type) {
    case "project":
      assertJobId(action.jobId);
      if (!ALIAS_PATTERN.test(action.alias)) throw new TypeError("alias is not valid callback data");
      encoded = `p:${action.jobId}:${action.alias}`;
      break;
    case "start":
      assertJobId(action.jobId);
      encoded = `s:${action.jobId}`;
      break;
    case "cancel":
      assertJobId(action.jobId);
      encoded = `c:${action.jobId}`;
      break;
    case "retry":
      assertJobId(action.jobId);
      encoded = `r:${action.jobId}`;
      break;
    case "review":
      assertJobId(action.jobId);
      encoded = `v:${action.jobId}`;
      break;
    case "merge":
      if (!NONCE_PATTERN.test(action.nonce)) throw new TypeError("nonce is not valid callback data");
      encoded = `m:${action.nonce}`;
      break;
    default:
      throw new TypeError("Unknown Telegram callback action");
  }
  assertCallbackLength(encoded);
  return encoded;
}

export function parseCallbackData(data: string): CallbackAction {
  if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > MAX_CALLBACK_BYTES) {
    throw new TypeError("Telegram callback data is invalid");
  }

  let match = /^p:([A-Za-z0-9_-]{22}):([a-z0-9][a-z0-9-]{0,23})$/.exec(data);
  if (match) return { type: "project", jobId: match[1], alias: match[2] };
  match = /^s:([A-Za-z0-9_-]{22})$/.exec(data);
  if (match) return { type: "start", jobId: match[1] };
  match = /^c:([A-Za-z0-9_-]{22})$/.exec(data);
  if (match) return { type: "cancel", jobId: match[1] };
  match = /^r:([A-Za-z0-9_-]{22})$/.exec(data);
  if (match) return { type: "retry", jobId: match[1] };
  match = /^v:([A-Za-z0-9_-]{22})$/.exec(data);
  if (match) return { type: "review", jobId: match[1] };
  match = /^m:([A-Za-z0-9_-]{32})$/.exec(data);
  if (match) return { type: "merge", nonce: match[1] };
  throw new TypeError("Telegram callback data is invalid");
}

function keyboard(buttons: InlineKeyboardButton[]): InlineKeyboardMarkup {
  return { inline_keyboard: buttons.map((button) => [button]) };
}

function projectFromRecord(record: ProjectRecord): ProjectPolicy | null {
  const candidate = "policy" in record ? record.policy : record;
  const parsed = projectPolicySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function renderProjectPicker(
  job: Pick<Job, "id" | "requestText">,
  projects: readonly ProjectRecord[],
): SendMessagePayload {
  assertJobId(job.id);
  const policies = projects.map(projectFromRecord).filter((policy): policy is ProjectPolicy => policy !== null && policy.enabled);
  const buttons: InlineKeyboardButton[] = policies.map((policy) => ({
    text: policy.alias,
    callback_data: encodeCallbackData({ type: "project", jobId: job.id, alias: policy.alias }),
  }));
  buttons.push({ text: "Cancel", callback_data: encodeCallbackData({ type: "cancel", jobId: job.id }) });
  const heading = policies.length > 0 ? "Choose a project" : "No enabled projects are configured";
  return {
    text: `${heading}.\nTask: <code>${html(job.requestText, 500)}</code>`,
    parse_mode: "HTML",
    reply_markup: keyboard(buttons),
  };
}

function normalizeStatusInput(
  input: Job | ({ job: Job } & JobStatusContext),
  extra: readonly unknown[],
): { job: Job; context: JobStatusContext } {
  if ("job" in input) {
    const { job, ...context } = input;
    return { job, context: { ...context, ...mergeContexts(extra) } };
  }
  return { job: input, context: mergeContexts(extra) };
}

function mergeContexts(values: readonly unknown[]): JobStatusContext {
  return values.reduce<JobStatusContext>((merged, value) => {
    if (typeof value === "string") return { ...merged, evidence: value };
    if (value && typeof value === "object") return { ...merged, ...(value as JobStatusContext) };
    return merged;
  }, {});
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || redact(value) !== value) return null;
    return value;
  } catch {
    return null;
  }
}

function formatExpiry(value: number | string | Date | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return displayText(value, 80);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resultLabel(value: string | undefined): string {
  return displayText(value ?? "unknown", 80);
}

function statusButtons(job: Job, context: JobStatusContext, ready: boolean): InlineKeyboardButton[] {
  const buttons: InlineKeyboardButton[] = [];
  const prUrl = safeHttpUrl(job.prUrl);
  const bbUrl = safeHttpUrl(context.bbAppBaseUrl);
  if (prUrl) buttons.push({ text: "View PR", url: prUrl });
  if (bbUrl) buttons.push({ text: "Open BB", url: bbUrl });

  if (ready) {
    buttons.push({ text: "Re-run Review", callback_data: encodeCallbackData({ type: "review", jobId: job.id }) });
    if (context.mergeNonce && NONCE_PATTERN.test(context.mergeNonce)) {
      buttons.push({ text: "Merge", callback_data: encodeCallbackData({ type: "merge", nonce: context.mergeNonce }) });
    }
  } else if (job.state === "awaiting_confirmation") {
    buttons.push({ text: "Start", callback_data: encodeCallbackData({ type: "start", jobId: job.id }) });
  } else if (job.state === "failed") {
    buttons.push({ text: "Retry", callback_data: encodeCallbackData({ type: "retry", jobId: job.id }) });
  } else if (job.state === "blocked") {
    buttons.push({ text: "Re-run Review", callback_data: encodeCallbackData({ type: "review", jobId: job.id }) });
  }

  if (!(["merged", "cancelled"].includes(job.state))) {
    buttons.push({ text: "Cancel", callback_data: encodeCallbackData({ type: "cancel", jobId: job.id }) });
  }
  return buttons;
}

export function renderJobStatus(
  input: Job | ({ job: Job } & JobStatusContext),
  ...extra: unknown[]
): SendMessagePayload {
  const { job, context } = normalizeStatusInput(input, extra);
  assertJobId(job.id);
  const policy = context.project ?? job.policy;
  const ready = context.ready ?? job.state === "awaiting_merge_approval";
  const title = ready ? "Ready to merge" : `Job ${displayText(job.state, 80)}`;
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `Project: <code>${html(policy?.alias ?? job.projectId ?? "unselected", 80)}</code>`,
  ];
  if (policy) lines.push(`Base: <code>${html(policy.baseBranch, 120)}</code>`);
  lines.push(`Task: <code>${html(job.requestText, 500)}</code>`);

  const pullRequest = context.pullRequest;
  if (job.prNumber !== null) {
    const prTitle = context.prTitle ?? pullRequest?.title;
    lines.push(`PR: #${job.prNumber}${prTitle ? ` ${html(prTitle, 180)}` : ""}`);
  }
  if (job.prUrl) lines.push(`PR URL: ${html(safeHttpUrl(job.prUrl) ?? "[redacted URL]", 300)}`);
  if (job.prHeadSha) lines.push(`Head: <code>${html(job.prHeadSha.slice(0, 16), 40)}</code>`);
  if (pullRequest || context.changedFiles !== undefined || context.diffStat) {
    const changedFiles = context.diffStat?.changedFiles ?? context.changedFiles ?? pullRequest?.changedFiles;
    const additions = context.diffStat?.additions ?? context.additions ?? pullRequest?.additions;
    const deletions = context.diffStat?.deletions ?? context.deletions ?? pullRequest?.deletions;
    if (changedFiles !== undefined && additions !== undefined && deletions !== undefined) {
      lines.push(`Diff: ${changedFiles} files, +${additions} / -${deletions}`);
    }
  }
  if (job.implementationThreadId) lines.push(`Implementation thread: <code>${html(job.implementationThreadId, 120)}</code>`);
  if (job.reviewThreadId) lines.push(`Review thread: <code>${html(job.reviewThreadId, 120)}</code>`);
  if (context.review) {
    const count = context.review.findings?.length ?? 0;
    lines.push(`Review: ${html(context.review.verdict ?? "unknown", 80)} (${count} findings)`);
    if (context.review.summary) lines.push(`Review summary: ${html(context.review.summary, 500)}`);
  }
  if (context.validation && context.validation.length > 0) {
    lines.push("Validation:");
    for (const item of context.validation.slice(0, 20)) {
      lines.push(`• ${html(item.name, 100)}: ${html(resultLabel(item.outcome), 80)}${item.summary ? ` — ${html(item.summary, 300)}` : ""}`);
    }
  }
  if (context.checks && context.checks.length > 0) {
    lines.push("Checks:");
    for (const item of context.checks.slice(0, 50)) {
      lines.push(`• ${html(item.name, 100)}: ${html(resultLabel(item.outcome ?? item.bucket), 80)}${item.summary ? ` — ${html(item.summary, 300)}` : ""}`);
    }
  }
  if (job.lastError) lines.push(`Blocker: ${html(job.lastError, 500)}`);
  if (job.reviewCycle > 0) lines.push(`Review cycle: ${job.reviewCycle}`);
  const expiry = formatExpiry(context.approvalExpiresAt);
  if (expiry) lines.push(`Approval expires: ${html(expiry, 100)}`);
  if (context.bbAppBaseUrl && safeHttpUrl(context.bbAppBaseUrl)) {
    lines.push(`<a href="${escapeHtml(context.bbAppBaseUrl)}">Open BB</a>`);
  }

  const baseText = lines.join("\n");
  const remainingEvidence = Math.max(0, MAX_TELEGRAM_TEXT_LENGTH - baseText.length - 12);
  if (context.evidence && remainingEvidence > 0) {
    lines.push(`Evidence:\n${html(context.evidence, Math.min(MAX_EVIDENCE_LENGTH, remainingEvidence))}`);
  }
  let text = lines.join("\n");
  if (text.length > MAX_TELEGRAM_TEXT_LENGTH) text = `${text.slice(0, MAX_TELEGRAM_TEXT_LENGTH - 1)}…`;

  const buttons = statusButtons(job, context, ready);
  return {
    text,
    parse_mode: "HTML",
    ...(buttons.length > 0 ? { reply_markup: keyboard(buttons) } : {}),
  };
}
