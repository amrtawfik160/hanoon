export type TelegramErrorKind =
  | "not_modified"
  | "expired_callback"
  | "edit_unavailable"
  | "bad_entities"
  | "authentication"
  | "retryable"
  | "permanent";

export type TelegramApiErrorInput = {
  httpStatus: number | null;
  errorCode: number;
  description?: string;
  retryAfterSeconds?: number | null;
  redact?: readonly string[];
};

function sanitizedDescription(value: string | undefined, secrets: readonly string[]): string | null {
  if (value === undefined) return null;
  let result = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[redacted]");
  }
  result = result
    .replace(/\bbot\d+:[A-Za-z0-9_-]+\b/g, "bot[redacted]")
    .replace(/\bBearer\s+\S+/gi, "[redacted]");
  if (result.length === 0) return null;
  return result.length <= 500 ? result : result.slice(0, 499) + "…";
}

export class TelegramApiError extends Error {
  public readonly httpStatus: number | null;
  public readonly errorCode: number;
  public readonly description: string | null;
  public readonly retryAfterSeconds: number | null;

  public constructor(input: TelegramApiErrorInput) {
    const description = sanitizedDescription(input.description, input.redact ?? []);
    const exposeDescription = input.errorCode !== 401 && input.errorCode !== 403;
    super(`Telegram API ${input.errorCode}${exposeDescription && description ? `: ${description}` : ""}`);
    this.name = "TelegramApiError";
    this.httpStatus = input.httpStatus;
    this.errorCode = input.errorCode;
    this.description = description;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

export function classifyTelegramError(error: unknown): TelegramErrorKind {
  if (!(error instanceof TelegramApiError)) return "retryable";
  const description = error.description?.toLowerCase() ?? "";
  if (description === "message is not modified" || description === "bad request: message is not modified") {
    return "not_modified";
  }
  if (
    description.includes("query is too old") ||
    description.includes("response timeout expired") ||
    description.includes("query id is invalid")
  ) {
    return "expired_callback";
  }
  if (
    description.includes("message to edit not found") ||
    description.includes("message can't be edited") ||
    description.includes("message can not be edited") ||
    description.includes("message_id_invalid")
  ) {
    return "edit_unavailable";
  }
  if (description.includes("can't parse entities") || description.includes("can't find end of the entity")) {
    return "bad_entities";
  }
  if (error.errorCode === 401 || error.httpStatus === 401) return "authentication";
  if (error.errorCode === 429 || error.errorCode >= 500 || (error.httpStatus !== null && error.httpStatus >= 500)) {
    return "retryable";
  }
  return "permanent";
}
