import { abortableSleep } from "../async";
import {
  telegramGetMeSchema,
  telegramSentMessageSchema,
  telegramUpdateSchema,
  type SendMessagePayload,
  type TelegramUpdate,
} from "./types";

const ORDINARY_REQUEST_TIMEOUT_MS = 15_000;
const MAX_LONG_POLL_TIMEOUT_SECONDS = 50;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRY_BASE_DELAY_MS = 250;
const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";

type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type TelegramFetch = typeof fetch;
type ClientDependencies = { sleep?: Sleep };

type ApiFailure = {
  ok: false;
  error_code: number;
  description?: string;
  parameters?: { retry_after?: number };
};

type ApiSuccess = { ok: true; result: unknown };
type ApiEnvelope = ApiFailure | ApiSuccess;
type TelegramRequest<T> = {
  method: string;
  payload: Record<string, unknown>;
  callerSignal?: AbortSignal;
  timeoutMs: number;
  parseResult: (apiResult: unknown) => T;
  allowNotModified?: boolean;
};

type AttemptResult = {
  envelope: ApiEnvelope;
  requestSignal: AbortSignal;
};

export class TelegramApiError extends Error {
  public readonly errorCode: number;

  public constructor(errorCode: number) {
    super(`Telegram API ${errorCode}`);
    this.name = "TelegramApiError";
    this.errorCode = errorCode;
  }
}

export class TelegramConflictError extends TelegramApiError {
  public constructor() {
    super(409);
    this.name = "TelegramConflictError";
  }
}

export class TelegramRequestError extends Error {
  public constructor(message: "Telegram request aborted" | "Telegram request failed") {
    super(message);
    this.name = "TelegramRequestError";
  }
}

export class TelegramResponseValidationError extends Error {
  public constructor() {
    super("Telegram response was invalid");
    this.name = "TelegramResponseValidationError";
  }
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null;
}

function isApiEnvelope(candidate: unknown): candidate is ApiEnvelope {
  if (!isRecord(candidate) || typeof candidate.ok !== "boolean") return false;
  if (candidate.ok) return "result" in candidate;
  return typeof candidate.error_code === "number" && Number.isInteger(candidate.error_code);
}

function retryDelay(failure: ApiFailure, retryIndex: number): number {
  const retryAfterSeconds = failure.parameters?.retry_after;
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(Math.ceil(retryAfterSeconds * 1_000), MAX_RETRY_DELAY_MS);
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** retryIndex, MAX_RETRY_DELAY_MS);
}

function isRetryable(errorCode: number): boolean {
  return errorCode === 429 || (errorCode >= 500 && errorCode <= 599);
}

function isNotModified(description: string | undefined): boolean {
  return description === "message is not modified" || description === "Bad Request: message is not modified";
}

function composeRequestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function safeRequestError(requestSignal: AbortSignal, callerSignal: AbortSignal | undefined): TelegramRequestError {
  const aborted = callerSignal?.aborted || requestSignal.aborted;
  return new TelegramRequestError(aborted ? "Telegram request aborted" : "Telegram request failed");
}

function parseUpdates(apiResult: unknown): TelegramUpdate[] {
  if (!Array.isArray(apiResult)) throw new TelegramResponseValidationError();
  const parsedUpdates = apiResult.map((candidate) => telegramUpdateSchema.safeParse(candidate));
  if (parsedUpdates.some((parsedUpdate) => !parsedUpdate.success)) {
    throw new TelegramResponseValidationError();
  }
  return parsedUpdates.map((parsedUpdate) => {
    if (!parsedUpdate.success) throw new TelegramResponseValidationError();
    return parsedUpdate.data;
  });
}

function parseSentMessage(apiResult: unknown): { message_id: number } {
  const parsedMessage = telegramSentMessageSchema.safeParse(apiResult);
  if (!parsedMessage.success) throw new TelegramResponseValidationError();
  return { message_id: parsedMessage.data.message_id };
}

function parseIdentity(apiResult: unknown): { id: number; username: string } {
  const parsedIdentity = telegramGetMeSchema.safeParse(apiResult);
  if (!parsedIdentity.success) throw new TelegramResponseValidationError();
  return { id: parsedIdentity.data.id, username: parsedIdentity.data.username };
}

function parseSuccessfulResult<T>(parseResult: (apiResult: unknown) => T, apiResult: unknown): T {
  try {
    return parseResult(apiResult);
  } catch (caughtError) {
    if (caughtError instanceof TelegramResponseValidationError) throw caughtError;
    throw new TelegramResponseValidationError();
  }
}

export class TelegramClient {
  private readonly sleep: Sleep;

  public constructor(
    private readonly token: string,
    private readonly fetchFn: TelegramFetch = fetch,
    dependencies: ClientDependencies = {},
  ) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Telegram bot token is required");
    this.sleep = dependencies.sleep ?? abortableSleep;
  }

  public getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > MAX_LONG_POLL_TIMEOUT_SECONDS) {
      throw new TypeError("timeoutSeconds must be an integer from 0 to 50");
    }
    return this.request({
      method: "getUpdates",
      payload: { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      callerSignal: signal,
      timeoutMs: (timeoutSeconds + 5) * 1_000,
      parseResult: parseUpdates,
    });
  }

  public sendMessage(chatId: string, payload: SendMessagePayload, signal?: AbortSignal): Promise<{ message_id: number }> {
    return this.request({
      method: "sendMessage",
      payload: { ...payload, chat_id: chatId },
      callerSignal: signal,
      timeoutMs: ORDINARY_REQUEST_TIMEOUT_MS,
      parseResult: parseSentMessage,
    });
  }

  public editMessage(chatId: string, messageId: number, payload: SendMessagePayload, signal?: AbortSignal): Promise<void> {
    if (!Number.isInteger(messageId) || messageId < 1) throw new TypeError("messageId must be a positive integer");
    return this.request({
      method: "editMessageText",
      payload: { ...payload, chat_id: chatId, message_id: messageId },
      callerSignal: signal,
      timeoutMs: ORDINARY_REQUEST_TIMEOUT_MS,
      parseResult: () => undefined,
      allowNotModified: true,
    });
  }

  public answerCallback(callbackQueryId: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.request({
      method: "answerCallbackQuery",
      payload: { callback_query_id: callbackQueryId, text },
      callerSignal: signal,
      timeoutMs: ORDINARY_REQUEST_TIMEOUT_MS,
      parseResult: () => undefined,
    });
  }

  public getMe(signal?: AbortSignal): Promise<{ id: number; username: string }> {
    return this.request({
      method: "getMe",
      payload: {},
      callerSignal: signal,
      timeoutMs: ORDINARY_REQUEST_TIMEOUT_MS,
      parseResult: parseIdentity,
    });
  }

  private async request<T>(request: TelegramRequest<T>): Promise<T> {
    const serializedPayload = serializePayload(request.payload);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const attemptResult = await this.performAttempt(request, serializedPayload);
      if (attemptResult.envelope.ok) {
        return parseSuccessfulResult(request.parseResult, attemptResult.envelope.result);
      }
      if (request.allowNotModified && attemptResult.envelope.error_code === 400 && isNotModified(attemptResult.envelope.description)) {
        return undefined as T;
      }
      if (attemptResult.envelope.error_code === 409) throw new TelegramConflictError();
      if (!isRetryable(attemptResult.envelope.error_code) || attempt === MAX_ATTEMPTS - 1) {
        throw new TelegramApiError(attemptResult.envelope.error_code);
      }
      await this.waitForRetry(request, attemptResult.envelope, attempt);
    }
    throw new TelegramRequestError("Telegram request failed");
  }

  private async performAttempt(request: TelegramRequest<unknown>, serializedPayload: string): Promise<AttemptResult> {
    const requestSignal = composeRequestSignal(request.callerSignal, request.timeoutMs);
    if (request.callerSignal?.aborted) throw safeRequestError(requestSignal, request.callerSignal);
    let response: Response;
    try {
      response = await this.fetchFn(`${TELEGRAM_API_ROOT}${this.token}/${request.method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serializedPayload,
        signal: requestSignal,
      });
    } catch {
      throw safeRequestError(requestSignal, request.callerSignal);
    }
    if (requestSignal.aborted) throw safeRequestError(requestSignal, request.callerSignal);
    return { envelope: await this.readEnvelope(response), requestSignal };
  }

  private async waitForRetry(
    request: TelegramRequest<unknown>,
    failure: ApiFailure,
    retryIndex: number,
  ): Promise<void> {
    const retrySignal = composeRequestSignal(request.callerSignal, request.timeoutMs);
    try {
      await this.sleep(retryDelay(failure, retryIndex), retrySignal);
    } catch {
      throw safeRequestError(retrySignal, request.callerSignal);
    }
  }

  private async readEnvelope(response: Response): Promise<ApiEnvelope> {
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return this.failureFromHttpStatus(response.status);
    }
    if (isApiEnvelope(responseBody)) return responseBody;
    return this.failureFromHttpStatus(response.status);
  }

  private failureFromHttpStatus(status: number): ApiEnvelope {
    if (status >= 400 && status <= 599) return { ok: false, error_code: status };
    throw new TelegramResponseValidationError();
  }
}

function serializePayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    throw new TelegramRequestError("Telegram request failed");
  }
}
