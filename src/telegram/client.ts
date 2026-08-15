import { abortableSleep } from "../async";
import {
  telegramGetMeSchema,
  telegramFileSchema,
  telegramSentMessageSchema,
  telegramUpdateSchema,
  type SendMessagePayload,
  type TelegramUpdate,
} from "./types";
import { TelegramApiError, type TelegramDeliveryOutcome } from "./errors";

export { TelegramApiError } from "./errors";

const ORDINARY_REQUEST_TIMEOUT_MS = 15_000;
const MAX_LONG_POLL_TIMEOUT_SECONDS = 50;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRY_BASE_DELAY_MS = 250;
const DEFINITELY_UNSENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";
const TELEGRAM_FILE_ROOT = "https://api.telegram.org/file/bot";

type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type TelegramFetch = typeof fetch;
type ClientDependencies = { sleep?: Sleep; maxAttempts?: number };

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
  maxAttempts?: number;
  parseResult: (apiResult: unknown) => T;
  allowNotModified?: boolean;
};

type AttemptResult = {
  envelope: ApiEnvelope;
  httpStatus: number;
  validatedEnvelope: boolean;
  requestSignal: AbortSignal;
};

export class TelegramConflictError extends TelegramApiError {
  public constructor(input: ConstructorParameters<typeof TelegramApiError>[0]) {
    super(input);
    this.name = "TelegramConflictError";
  }
}

export class TelegramRequestError extends Error {
  public readonly deliveryOutcome: TelegramDeliveryOutcome;

  public constructor(
    message: "Telegram request aborted" | "Telegram request failed",
    deliveryOutcome: TelegramDeliveryOutcome = "unknown",
  ) {
    super(message);
    this.name = "TelegramRequestError";
    this.deliveryOutcome = deliveryOutcome;
  }
}

export class TelegramFileTooLargeError extends Error {
  public constructor() {
    super("Telegram file exceeds the configured size limit");
    this.name = "TelegramFileTooLargeError";
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

function validatedMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS) {
    throw new TypeError("maxAttempts must be an integer from 1 to 4");
  }
  return value;
}

function retryAfterSeconds(failure: ApiFailure): number | null {
  const retryAfter = failure.parameters?.retry_after;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter
    : null;
}

function retryDelay(failure: ApiFailure, retryIndex: number): number {
  const serverDelaySeconds = retryAfterSeconds(failure);
  if (serverDelaySeconds !== null) {
    return Math.ceil(serverDelaySeconds * 1_000);
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** retryIndex, MAX_RETRY_DELAY_MS);
}

function isRetryable(errorCode: number): boolean {
  return errorCode === 429 || (errorCode >= 500 && errorCode <= 599);
}

function isNotModified(description: string | undefined): boolean {
  const normalized = description?.toLowerCase();
  return normalized === "message is not modified" ||
    normalized?.startsWith("bad request: message is not modified") === true;
}

function composeRequestSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function fetchFailureDeliveryOutcome(error: unknown): TelegramDeliveryOutcome {
  if (!isRecord(error)) return "unknown";
  const failure = isRecord(error.cause) ? error.cause : error;
  const code = typeof failure.code === "string" ? failure.code : null;
  if (code !== null && DEFINITELY_UNSENT_NETWORK_CODES.has(code)) return "not_sent";
  const socket = isRecord(failure.socket) ? failure.socket : null;
  return socket?.bytesWritten === 0 ? "not_sent" : "unknown";
}

function safeRequestError(
  requestSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  deliveryOutcome: TelegramDeliveryOutcome = "unknown",
): TelegramRequestError {
  const aborted = callerSignal?.aborted || requestSignal.aborted;
  return new TelegramRequestError(
    aborted ? "Telegram request aborted" : "Telegram request failed",
    deliveryOutcome,
  );
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

function parseFile(apiResult: unknown): {
  filePath: string;
  fileSize: number | null;
} {
  const parsedFile = telegramFileSchema.safeParse(apiResult);
  if (!parsedFile.success) throw new TelegramResponseValidationError();
  return {
    filePath: parsedFile.data.file_path,
    fileSize: parsedFile.data.file_size ?? null,
  };
}

function safeFilePath(value: string): string {
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TelegramResponseValidationError();
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function responseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new TelegramFileTooLargeError();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TelegramFileTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
  private readonly maxAttempts: number;

  public constructor(
    private readonly token: string,
    private readonly fetchFn: TelegramFetch = fetch,
    dependencies: ClientDependencies = {},
  ) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("Telegram bot token is required");
    this.sleep = dependencies.sleep ?? abortableSleep;
    this.maxAttempts = validatedMaxAttempts(dependencies.maxAttempts ?? MAX_ATTEMPTS);
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

  public sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void> {
    if (action !== "typing") throw new TypeError("Unsupported Telegram chat action");
    return this.request({
      method: "sendChatAction",
      payload: { chat_id: chatId, action },
      callerSignal: signal,
      timeoutMs: 5_000,
      maxAttempts: 1,
      parseResult: () => undefined,
    });
  }

  public sendMessageDraft(
    chatId: string,
    draftId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(draftId) || draftId === 0) {
      throw new TypeError("draftId must be a non-zero safe integer");
    }
    return this.request({
      method: "sendMessageDraft",
      payload: { chat_id: chatId, draft_id: draftId, text },
      callerSignal: signal,
      timeoutMs: 5_000,
      maxAttempts: 1,
      parseResult: () => undefined,
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

  public async downloadFile(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 1_024) {
      throw new TypeError("fileId must be between 1 and 1024 characters");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("maxBytes must be a positive safe integer");
    }
    const file = await this.request({
      method: "getFile",
      payload: { file_id: fileId },
      callerSignal: signal,
      timeoutMs: ORDINARY_REQUEST_TIMEOUT_MS,
      parseResult: parseFile,
    });
    if (file.fileSize !== null && file.fileSize > maxBytes) {
      throw new TelegramFileTooLargeError();
    }
    const requestSignal = composeRequestSignal(signal, ORDINARY_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(
        `${TELEGRAM_FILE_ROOT}${this.token}/${safeFilePath(file.filePath)}`,
        {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal: requestSignal,
        },
      );
    } catch (error) {
      if (error instanceof TelegramResponseValidationError) throw error;
      throw safeRequestError(requestSignal, signal);
    }
    if (requestSignal.aborted) throw safeRequestError(requestSignal, signal);
    if (!response.ok) throw new TelegramRequestError("Telegram request failed");
    const contentLength = responseContentLength(response);
    if (contentLength !== null && contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new TelegramFileTooLargeError();
    }
    try {
      return await readBoundedBytes(response, maxBytes);
    } catch (error) {
      if (error instanceof TelegramFileTooLargeError) throw error;
      throw safeRequestError(requestSignal, signal);
    }
  }

  private async request<T>(request: TelegramRequest<T>): Promise<T> {
    const maxAttempts = validatedMaxAttempts(request.maxAttempts ?? this.maxAttempts);
    const serializedPayload = serializePayload(request.payload);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptResult = await this.performAttempt(request, serializedPayload);
      if (attemptResult.envelope.ok) {
        return parseSuccessfulResult(request.parseResult, attemptResult.envelope.result);
      }
      if (request.allowNotModified && attemptResult.envelope.error_code === 400 && isNotModified(attemptResult.envelope.description)) {
        return undefined as T;
      }
      const apiError = new TelegramApiError({
        httpStatus: attemptResult.httpStatus,
        errorCode: attemptResult.envelope.error_code,
        description: attemptResult.envelope.description,
        retryAfterSeconds: retryAfterSeconds(attemptResult.envelope),
        deliveryOutcome: !attemptResult.validatedEnvelope && attemptResult.httpStatus >= 500
          ? "unknown"
          : "not_sent",
        redact: [this.token],
      });
      if (attemptResult.envelope.error_code === 409) throw new TelegramConflictError({
        httpStatus: apiError.httpStatus,
        errorCode: apiError.errorCode,
        description: apiError.description ?? undefined,
        retryAfterSeconds: apiError.retryAfterSeconds,
      });
      if (!isRetryable(attemptResult.envelope.error_code) || attempt === maxAttempts - 1) {
        throw apiError;
      }
      await this.waitForRetry(request, attemptResult.envelope, attempt);
    }
    throw new TelegramRequestError("Telegram request failed");
  }

  private async performAttempt(request: TelegramRequest<unknown>, serializedPayload: string): Promise<AttemptResult> {
    const requestSignal = composeRequestSignal(request.callerSignal, request.timeoutMs);
    if (request.callerSignal?.aborted) throw safeRequestError(requestSignal, request.callerSignal, "not_sent");
    let response: Response;
    try {
      response = await this.fetchFn(`${TELEGRAM_API_ROOT}${this.token}/${request.method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serializedPayload,
        signal: requestSignal,
      });
    } catch (error) {
      throw safeRequestError(requestSignal, request.callerSignal, fetchFailureDeliveryOutcome(error));
    }
    if (requestSignal.aborted) throw safeRequestError(requestSignal, request.callerSignal);
    const parsedResponse = await this.readEnvelope(response);
    return {
      envelope: parsedResponse.envelope,
      httpStatus: response.status,
      validatedEnvelope: parsedResponse.validated,
      requestSignal,
    };
  }

  private async waitForRetry(
    request: TelegramRequest<unknown>,
    failure: ApiFailure,
    retryIndex: number,
  ): Promise<void> {
    // The ordinary request timeout applies to one HTTP attempt, not to the
    // server-directed quiet period between attempts. A 429 retry_after can be
    // longer than that timeout, so only an explicit caller signal may cancel
    // this wait.
    const retrySignal = request.callerSignal ?? new AbortController().signal;
    try {
      await this.sleep(retryDelay(failure, retryIndex), retrySignal);
    } catch {
      throw safeRequestError(retrySignal, request.callerSignal);
    }
  }

  private async readEnvelope(response: Response): Promise<{ envelope: ApiEnvelope; validated: boolean }> {
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return { envelope: this.failureFromHttpStatus(response.status), validated: false };
    }
    if (isApiEnvelope(responseBody)) return { envelope: responseBody, validated: true };
    return { envelope: this.failureFromHttpStatus(response.status), validated: false };
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
    throw new TelegramRequestError("Telegram request failed", "not_sent");
  }
}
