import { projectPolicySchema, type Job, type ProjectPolicy, type WorkerLiveness } from "../domain/models";
import type { JobAdmission } from "../autonomy/models";
import { hashSecret } from "../crypto";
import { assertSafeExternalHttpsUrl } from "../storage/store";
import type { ResourceWaitProjection } from "../storage/autonomy-repository";
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RAW_MERGE_CALLBACK_PATTERN = /m:[A-Za-z0-9_-]{32}/;
const ENCODED_MERGE_CALLBACK_PATTERN = /(?:m|%6d)%3a[A-Za-z0-9_-]{32}/i;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|auth[_-]?(?:token|key)|session[_-]?token|private[_-]?key|credentials?|password|secret|token|key)["']?\s*[:=]\s*["']?[^\s"'&;,)}\]]+/gi;

export type CallbackAction =
  | { type: "project"; jobId: string; alias: string }
  | { type: "start"; jobId: string }
  | { type: "cancel"; jobId: string }
  | { type: "retry"; jobId: string }
  | { type: "review"; jobId: string }
  | { type: "merge"; nonce: string }
  | { type: "operation"; nonce: string }
  /** One decision the hidden controller thread is blocked on. */
  | ControllerInteractionCallbackAction
  /**
   * A legacy controller question button. Migrated in-flight messages are still
   * answerable for one release; no new `q:` value is ever emitted.
   */
  | { type: "question"; token: string }
  /** One choice offered for a watched thread that is waiting on the owner. */
  | { type: "thread_interaction"; token: string };

export type ControllerInteractionCallbackAction = {
  type: "controller_interaction";
  token: string;
};

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
  admission?: JobAdmission | null;
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
  mergeNonceHash?: string;
  ready?: boolean;
  workerLiveness?: WorkerLiveness | null;
  resourceWait?: readonly ResourceWaitProjection[];
  now?: number;
};

export type JobStatusSummaryItem = Readonly<{
  job: Job;
  admission: JobAdmission | null;
}>;

const STATUS_SUMMARY_LIMIT = 8;

function summaryGroup(item: JobStatusSummaryItem): string {
  if (item.admission?.state === "queued") return "Queued";
  if (item.admission?.state === "draining") return "Draining";
  if (item.job.state === "awaiting_merge_approval") return "Approval waiting";
  if (item.job.state === "failed") return "Failed";
  return "Running";
}

function summaryLine(item: JobStatusSummaryItem): string {
  const project = item.job.policy?.alias ?? item.job.projectId ?? "unselected";
  return `• <code>${html(item.job.id, 256)}</code> — <code>${html(project, 80)}</code>`;
}

export function renderJobStatusSummary(input: {
  jobs: readonly JobStatusSummaryItem[];
  total: number;
}): SendMessagePayload {
  if (!Number.isSafeInteger(input.total) || input.total < input.jobs.length) {
    throw new TypeError("status summary total is invalid");
  }
  const displayed = input.jobs.slice(0, STATUS_SUMMARY_LIMIT);
  if (displayed.length === 0) return { text: "No active jobs.", disable_web_page_preview: true };
  const groups = new Map<string, JobStatusSummaryItem[]>();
  for (const item of displayed) {
    const label = summaryGroup(item);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  const order = ["Running", "Approval waiting", "Draining", "Queued", "Failed"];
  const lines: string[] = ["<b>Jobs</b>"];
  for (const label of order) {
    const items = groups.get(label);
    if (!items) continue;
    lines.push(`<b>${label}</b>`, ...items.map(summaryLine));
  }
  const remaining = Math.max(0, input.total - displayed.length);
  if (remaining > 0) lines.push(`${remaining} more ${remaining === 1 ? "job" : "jobs"}`);
  return {
    text: truncateHtml(lines.join("\n"), MAX_TELEGRAM_TEXT_LENGTH),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
}

export function renderJobChoices(
  action: "cancel" | "retry",
  jobs: readonly Job[],
  total: number,
): SendMessagePayload {
  if (!Number.isSafeInteger(total) || total < jobs.length) throw new TypeError("job choice total is invalid");
  const displayed = jobs.slice(0, STATUS_SUMMARY_LIMIT);
  const lines = [`<b>Choose a job to ${action}</b>`];
  for (const job of displayed) {
    lines.push(summaryLine({ job, admission: null }));
  }
  const remaining = Math.max(0, total - displayed.length);
  if (remaining > 0) lines.push(`${remaining} more ${remaining === 1 ? "job" : "jobs"}`);
  lines.push(`Use <code>/${action} JOB_ID</code> or reply to its status message.`);
  return {
    text: truncateHtml(lines.join("\n"), MAX_TELEGRAM_TEXT_LENGTH),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
}

function containsForbiddenCallbackMaterial(value: string): boolean {
  let candidate = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (RAW_MERGE_CALLBACK_PATTERN.test(candidate) || ENCODED_MERGE_CALLBACK_PATTERN.test(candidate)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return RAW_MERGE_CALLBACK_PATTERN.test(candidate) || ENCODED_MERGE_CALLBACK_PATTERN.test(candidate);
}

function sanitizePersistedValue(value: unknown): unknown {
  if (typeof value === "string") return containsForbiddenCallbackMaterial(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(sanitizePersistedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      containsForbiddenCallbackMaterial(key) ? "[redacted-key]" : key,
      sanitizePersistedValue(entry),
    ]));
  }
  return value;
}

type ApprovalDeliveryMetadata = {
  nonceHash: string;
  jobId: string;
  headSha: string | null;
  expiresAt: number | null;
};

type RenderedStatusPayload = SendMessagePayload & {
  __approval_metadata?: ApprovalDeliveryMetadata;
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
  if (containsForbiddenCallbackMaterial(value)) return "[redacted]";
  return value
    .replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "$1[redacted]")
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
      return result.length + 1 <= maxLength ? `${result}…` : result;
    }
    result += escaped;
  }
  return result;
}

type HtmlToken =
  | { type: "tag"; raw: string; name: string; closing: boolean }
  | { type: "entity" | "text"; raw: string };

function readHtmlToken(source: string, index: number): HtmlToken {
  if (source[index] === "<") {
    const end = source.indexOf(">", index);
    if (end >= 0) {
      const raw = source.slice(index, end + 1);
      const closing = /^<\/(b|code|a)>$/.exec(raw);
      if (closing) return { type: "tag", raw, name: closing[1], closing: true };
      const opening = /^<(b|code|a)(?:\s+[^<>]*)?>$/.exec(raw);
      if (opening) return { type: "tag", raw, name: opening[1], closing: false };
    }
  }
  if (source[index] === "&") {
    const entity = /^&(amp|lt|gt|quot|#39);/.exec(source.slice(index));
    if (entity) return { type: "entity", raw: entity[0] };
  }
  const codePoint = source.codePointAt(index);
  const raw = codePoint === undefined ? "" : String.fromCodePoint(codePoint);
  return { type: "text", raw };
}

function truncateHtml(source: string, maxLength: number): string {
  if (source.length <= maxLength) return source;

  let result = "";
  let index = 0;
  const openTags: string[] = [];
  const closingTags = () => openTags.slice().reverse().map((name) => `</${name}>`).join("");
  const truncated = () => `${result}…${closingTags()}`;

  while (index < source.length) {
    const token = readHtmlToken(source, index);
    const suffixLength = 1 + closingTags().length;
    if (token.type === "tag" && !token.closing) {
      const closingTagLength = `</${token.name}>`.length;
      if (result.length + token.raw.length + suffixLength + closingTagLength > maxLength) {
        return truncated();
      }
      result += token.raw;
      openTags.push(token.name);
    } else if (token.type === "tag") {
      if (result.length + token.raw.length > maxLength) return truncated();
      result += token.raw;
      if (openTags[openTags.length - 1] === token.name) openTags.pop();
    } else {
      if (result.length + token.raw.length + suffixLength > maxLength) return truncated();
      result += token.raw;
    }
    index += token.raw.length;
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
    case "operation":
      if (!NONCE_PATTERN.test(action.nonce)) throw new TypeError("nonce is not valid callback data");
      encoded = `o:${action.nonce}`;
      break;
    case "controller_interaction":
      if (!NONCE_PATTERN.test(action.token)) throw new TypeError("token is not valid callback data");
      encoded = `i:${action.token}`;
      break;
    case "thread_interaction":
      if (!NONCE_PATTERN.test(action.token)) throw new TypeError("token is not valid callback data");
      encoded = `w:${action.token}`;
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
  match = /^o:([A-Za-z0-9_-]{32})$/.exec(data);
  if (match) return { type: "operation", nonce: match[1] };
  match = /^i:([A-Za-z0-9_-]{32})$/.exec(data);
  if (match) return { type: "controller_interaction", token: match[1] };
  // Retained for one release so a migrated in-flight question stays answerable.
  match = /^q:([A-Za-z0-9_-]{32})$/.exec(data);
  if (match) return { type: "question", token: match[1] };
  match = /^w:([A-Za-z0-9_-]{32})$/.exec(data);
  if (match) return { type: "thread_interaction", token: match[1] };
  throw new TypeError("Telegram callback data is invalid");
}

function approvalExpiryMillis(value: number | string | Date | undefined): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function approvalMetadata(
  payload: RenderedStatusPayload,
): ApprovalDeliveryMetadata | undefined {
  const metadata = payload.__approval_metadata;
  if (!metadata || !SHA256_PATTERN.test(metadata.nonceHash) || !validJobId(metadata.jobId)) return undefined;
  if (metadata.headSha !== null && !/^[0-9a-f]{40}$/.test(metadata.headSha)) return undefined;
  return {
    nonceHash: metadata.nonceHash,
    jobId: metadata.jobId,
    headSha: metadata.headSha,
    expiresAt: metadata.expiresAt,
  };
}

/** Remove internal approval metadata while retaining the raw callback for one in-memory Telegram delivery. */
export function ephemeralTelegramPayload(payload: SendMessagePayload): SendMessagePayload {
  const { __approval_metadata: _metadata, ...telegramPayload } = payload as RenderedStatusPayload;
  return telegramPayload;
}

/** Make a crash-safe outbox payload: raw approval callbacks are removed, hash metadata is retained. */
export function persistableJobStatusPayload(payload: SendMessagePayload): Record<string, unknown> {
  const rendered = payload as RenderedStatusPayload;
  const { __approval_metadata: _metadata, reply_markup: markup, ...rest } = rendered;
  const persisted: Record<string, unknown> = sanitizePersistedValue({ ...rest }) as Record<string, unknown>;
  if (markup) {
    persisted.reply_markup = {
      inline_keyboard: markup.inline_keyboard
        .map((row) => row.filter((button) =>
          !(typeof button.callback_data === "string" && containsForbiddenCallbackMaterial(button.callback_data))))
        .filter((row) => row.length > 0),
    } satisfies InlineKeyboardMarkup;
  }
  const metadata = approvalMetadata(rendered);
  if (metadata) persisted.approval_metadata = metadata;
  return sanitizePersistedValue(persisted) as Record<string, unknown>;
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
    return assertSafeExternalHttpsUrl(value);
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
  if (job.cancelRequestedAt !== null) return buttons;

  const livenessBlocked = context.workerLiveness?.state === "unknown" || context.workerLiveness?.state === "stale";
  const queuedConfirmation = job.state === "awaiting_confirmation" &&
    context.admission?.jobId === job.id &&
    context.admission.state === "queued";
  if (ready && !livenessBlocked) {
    buttons.push({ text: "Re-run Review", callback_data: encodeCallbackData({ type: "review", jobId: job.id }) });
    if (context.mergeNonce && NONCE_PATTERN.test(context.mergeNonce)) {
      const shortSha = job.prHeadSha?.slice(0, 8) ?? "approved";
      buttons.push({ text: `Merge + deploy ${shortSha}`, callback_data: encodeCallbackData({ type: "merge", nonce: context.mergeNonce }) });
    }
  } else if (job.state === "awaiting_confirmation" && !queuedConfirmation && !livenessBlocked) {
    buttons.push({ text: "Start", callback_data: encodeCallbackData({ type: "start", jobId: job.id }) });
  } else if (job.state === "failed" && !livenessBlocked) {
    buttons.push({ text: "Retry", callback_data: encodeCallbackData({ type: "retry", jobId: job.id }) });
  } else if (job.state === "blocked" && !livenessBlocked) {
    buttons.push({ text: "Re-run Review", callback_data: encodeCallbackData({ type: "review", jobId: job.id }) });
  }

  if (!(["merged", "cancelled", "deploying", "verifying_production", "production_failed", "complete"].includes(job.state))) {
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
  // A confirmed job waiting for a slot has no button and needs nothing from the
  // owner, so titling it "awaiting_confirmation" reads as a demand for a tap
  // that does not exist.
  const queuedConfirmed = job.state === "awaiting_confirmation" &&
    context.admission?.jobId === job.id &&
    context.admission.state === "queued";
  const title = ready
    ? "Ready to merge and deploy"
    : job.state === "production_failed"
      ? "PRODUCTION INCIDENT"
      : job.state === "complete"
        ? "Merged, deployed, and verified"
        : queuedConfirmed
          ? "Job queued"
          : `Job ${displayText(job.state, 80)}`;
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `Project: <code>${html(policy?.alias ?? job.projectId ?? "unselected", 80)}</code>`,
  ];
  if (policy) lines.push(`Base: <code>${html(policy.baseBranch, 120)}</code>`);
  lines.push(`Task: <code>${html(job.requestText, 500)}</code>`);
  if (queuedConfirmed) {
    lines.push("Queue: waiting for a free slot — starts on its own, nothing to approve");
  } else if (job.state === "awaiting_confirmation") {
    lines.push("Waiting for you to start it");
  }
  const resourceWait = (context.resourceWait ?? [])
    .filter((entry) => entry.kind === "repository_merge" || entry.kind === "production_target")
    .slice(0, 3);
  if (resourceWait.length > 0) {
    lines.push("Resource wait:");
    for (const entry of resourceWait) {
      lines.push(`• ${html(entry.kind, 80)}: <code>${html(entry.key, 240)}</code>`);
    }
  }

  const pullRequest = context.pullRequest;
  if (job.prNumber !== null) {
    const prTitle = context.prTitle ?? pullRequest?.title;
    lines.push(`PR: #${job.prNumber}${prTitle ? ` ${html(prTitle, 180)}` : ""}`);
  }
  if (job.prUrl) lines.push(`PR URL: ${html(safeHttpUrl(job.prUrl) ?? "[redacted URL]", 300)}`);
  if (job.prHeadSha) lines.push(`Head: <code>${html(job.prHeadSha.slice(0, 16), 40)}</code>`);
  if (job.mergeMessage) lines.push(`Merge: ${html(job.mergeMessage, 500)}`);
  if (job.mergeCommitSha) lines.push(`Merge commit: <code>${html(job.mergeCommitSha.slice(0, 16), 40)}</code>`);
  if (job.mergedAt) lines.push(`Merged at: <code>${html(job.mergedAt, 80)}</code>`);
  if (job.deploymentSummary) lines.push(`Deploy: ${html(job.deploymentSummary, 500)}`);
  if (job.canarySummary) lines.push(`Canary: ${html(job.canarySummary, 500)}`);
  if (job.state === "production_failed") {
    lines.push("The merge succeeded, but production did not pass. No automatic rollback was attempted; follow the configured operator rollback procedure.");
  }
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
  if (job.documentationThreadId) lines.push(`Docs thread: <code>${html(job.documentationThreadId, 120)}</code>`);
  if (context.workerLiveness) {
    const worker = context.workerLiveness;
    const now = context.now ?? worker.observedAt;
    const ageSeconds = Math.max(0, Math.floor((now - worker.sourceUpdatedAt) / 1_000));
    lines.push(`Worker: ${html(worker.resourceId, 120)} (<code>${html(worker.state, 40)}</code>)`);
    lines.push(`Observation age: <code>${ageSeconds}s ago</code>`);
    if (worker.state === "unknown") {
      lines.push("Warning: waiting for an authoritative BB observation; no worker diagnosis is available.");
    } else if (worker.state === "stale") {
      lines.push("Warning: waiting for a fresh BB observation; no worker diagnosis is available.");
    }
  }
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
  const text = truncateHtml(lines.join("\n"), MAX_TELEGRAM_TEXT_LENGTH);

  const buttons = statusButtons(job, context, ready);
  const nonceHash = context.mergeNonceHash ??
    (context.mergeNonce && NONCE_PATTERN.test(context.mergeNonce) ? hashSecret(context.mergeNonce) : undefined);
  const expiresAt = approvalExpiryMillis(context.approvalExpiresAt);
  return {
    text,
    parse_mode: "HTML",
    ...(buttons.length > 0 ? { reply_markup: keyboard(buttons) } : {}),
    ...(nonceHash && SHA256_PATTERN.test(nonceHash)
      ? {
          __approval_metadata: {
            nonceHash,
            jobId: job.id,
            headSha: job.prHeadSha,
            expiresAt,
          },
        }
      : {}),
  };
}
