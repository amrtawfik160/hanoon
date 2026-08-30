import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type TerminalScope =
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; hostId: string; cwd: string | null };

export type CommandResult =
  | { outcome: "exited"; exitCode: number; output: string; outputTruncated?: true }
  | { outcome: "timed_out" }
  | { outcome: "aborted" };

export type TerminalObservation = {
  id: string;
  status: string;
  updatedAt: number;
  exitCode?: number | null;
};

export interface TerminalRunInput {
  scope: TerminalScope;
  title: string;
  command: string;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onObservation?: (observation: TerminalObservation) => void;
}

type TerminalClient = {
  create(input: {
    cols: number;
    rows: number;
    scope: TerminalScope;
    start: { mode: "command"; command: string };
    title: string;
  }): Promise<{ id: string }>;
  get(input: { terminalId: string; signal?: AbortSignal }): Promise<{ status: string; exitCode?: number | null }>;
  output(input: { terminalId: string; sinceSeq: number; tailBytes: number; signal?: AbortSignal }): Promise<{
    chunks: Array<{ seq?: number; sequence?: number; dataBase64?: string; data?: string }>;
    nextSeq?: number;
    truncated?: boolean;
  }>;
  input(input: { terminalId: string; dataBase64: string }): Promise<unknown>;
  close(input: { terminalId: string; mode: "force" }): Promise<unknown>;
};

type BbSdk = BbPluginApi["sdk"];

type BoundedResult<T> =
  | { outcome: "value"; value: T }
  | { outcome: "timed_out" }
  | { outcome: "aborted" };

type TerminalOutputBuffer = Readonly<{
  nextSeq: number;
  output: string;
  truncated: boolean;
}>;

const POLL_INTERVAL_MS = 250;
const DEFAULT_OUTPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 8_388_608;
const RESULT_MARKER_PREFIX = "__BB_TELEGRAM_AGENT_RESULT_";
const EMPTY_TERMINAL_OUTPUT: TerminalOutputBuffer = { nextSeq: 0, output: "", truncated: false };

function stripAnsi(terminalOutput: string): string {
  return terminalOutput
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
}

const NON_JSON_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function jsonValueEnd(text: string, start: number): number | null {
  const expectedClosers: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      expectedClosers.push("}");
    } else if (character === "[") {
      expectedClosers.push("]");
    } else if (character === "}" || character === "]") {
      if (expectedClosers.at(-1) !== character) return null;
      expectedClosers.pop();
      if (expectedClosers.length === 0) return index + 1;
    }
  }
  return null;
}

/**
 * Parses JSON from terminal output without treating printable noise as control
 * data. The terminal may leave an escape fragment before the payload, while
 * titles and review bodies may legitimately contain brackets and punctuation.
 */
export function parseCommandJson<T>(terminalOutput: string, title: string): T {
  const cleaned = stripAnsi(terminalOutput).replace(NON_JSON_CONTROL_CHARACTERS, "");
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== "{" && cleaned[start] !== "[") continue;
    const end = jsonValueEnd(cleaned, start);
    if (end === null) continue;
    try {
      return JSON.parse(cleaned.slice(start, end)) as T;
    } catch {
      // A printable bracket in terminal noise is not the payload. Try the next
      // possible JSON root without altering the payload's printable content.
    }
  }
  throw new Error(`${title}: command output did not contain a valid JSON payload`);
}

function collectOutput(chunks: Array<{ seq?: number; sequence?: number; dataBase64?: string; data?: string }>): string {
  return stripAnsi(
    [...chunks]
      .sort((left, right) => (left.seq ?? left.sequence ?? 0) - (right.seq ?? right.sequence ?? 0))
      .map((encodedChunk) => {
        const encodedOutput = encodedChunk.dataBase64 ?? encodedChunk.data ?? "";
        return Buffer.from(encodedOutput, "base64").toString("utf8");
      })
      .join(""),
  );
}

/**
 * Single-quote a value for the shell. Exported because everything that builds a
 * command out of untrusted text needs exactly this quoting, and a second copy is
 * a second chance to get shell escaping subtly wrong.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandEnvelope(command: string, marker: string, stdinBytes: number | null): string {
  if (command.includes("\0")) throw new TypeError("command must not contain NUL bytes");
  return [
    ...(stdinBytes === null ? [] : ["stty raw -echo || exit 125", `printf '\\n${marker}_STDIN_READY\\n'`]),
    `__bb_telegram_agent_command=${shellSingleQuote(command)}`,
    stdinBytes === null
      ? '"${SHELL:-/bin/sh}" -lc "$__bb_telegram_agent_command"'
      : `head -c ${stdinBytes} | "\${SHELL:-/bin/sh}" -lc "$__bb_telegram_agent_command"`,
    "__bb_telegram_agent_exit=$?",
    ...(stdinBytes === null ? [] : ["stty sane"]),
    `printf '\\n${marker}:%s\\n' "$__bb_telegram_agent_exit"`,
    "IFS= read -r __bb_telegram_agent_release",
    'exit "$__bb_telegram_agent_exit"',
  ].join("; ");
}

function parseCommandResult(output: string, marker: string): { exitCode: number; output: string } | null {
  const expression = new RegExp(`(?:\\r?\\n)${marker}:([0-9]{1,3})(?:\\r?\\n)`);
  const match = expression.exec(output);
  if (!match || match.index === undefined) return null;
  const exitCode = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) return null;
  return {
    exitCode,
    output: output.slice(0, match.index) + output.slice(match.index + match[0].length),
  };
}

function appendBounded(
  current: string,
  next: string,
  maximumBytes: number,
): Readonly<{ output: string; truncated: boolean }> {
  const bytes = Buffer.from(current + next, "utf8");
  return bytes.length <= maximumBytes
    ? { output: bytes.toString("utf8"), truncated: false }
    : {
        output: bytes.subarray(bytes.length - maximumBytes).toString("utf8"),
        truncated: true,
      };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  const abortSignal = signal;
  if (abortSignal?.aborted) return Promise.reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(abortSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class TerminalCommandRunner {
  public constructor(public readonly sdk: Pick<BbSdk, "terminals">) {}

  private terminals(): TerminalClient {
    return this.sdk.terminals as unknown as TerminalClient;
  }

  private closeWithoutWaiting(terminalId: string): void {
    try {
      void Promise.resolve(this.terminals().close({ terminalId, mode: "force" })).catch(() => undefined);
    } catch {
      // A close invocation can fail synchronously after the terminal outcome is fixed.
    }
  }

  private async collect(
    terminalId: string,
    sinceSeq: number,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<TerminalOutputBuffer> {
    const result = await this.terminals().output({ terminalId, sinceSeq, tailBytes: maximumBytes, signal });
    return {
      nextSeq: result.nextSeq ?? sinceSeq,
      output: collectOutput(result.chunks),
      truncated: result.truncated === true,
    };
  }

  private async start(input: TerminalRunInput): Promise<{ id: string; marker: string }> {
    const marker = `${RESULT_MARKER_PREFIX}${randomBytes(16).toString("hex")}__`;
    const session = await this.terminals().create({
      cols: 120,
      rows: 40,
      scope: input.scope,
      start: {
        mode: "command",
        command: commandEnvelope(
          input.command,
          marker,
          input.stdin === undefined ? null : Buffer.byteLength(input.stdin, "utf8"),
        ),
      },
      title: input.title,
    });
    return { id: session.id, marker };
  }

  private bounded<T>(
    operation: () => Promise<T>,
    deadline: number,
    signal?: AbortSignal,
    onLateValue?: (value: T) => void,
  ): Promise<BoundedResult<T>> {
    if (signal?.aborted) return Promise.resolve({ outcome: "aborted" });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve({ outcome: "timed_out" });
    return new Promise<BoundedResult<T>>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (result: BoundedResult<T>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => finish({ outcome: "aborted" });
      timer = setTimeout(() => finish({ outcome: "timed_out" }), remaining);
      signal?.addEventListener("abort", onAbort, { once: true });
      void operation().then(
        (value) => {
          if (settled) {
            onLateValue?.(value);
            return;
          }
          finish({ outcome: "value", value });
        },
        (error: unknown) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(error);
          }
        },
      );
    });
  }

  private async waitForExit(
    terminalId: string,
    deadline: number,
    signal: AbortSignal | undefined,
    closeOnce: () => void,
    resultMarker: string,
    maximumBytes: number,
    onObservation?: (observation: TerminalObservation) => void,
    initialBuffer = EMPTY_TERMINAL_OUTPUT,
  ): Promise<CommandResult> {
    let nextSeq = initialBuffer.nextSeq;
    let output = initialBuffer.output;
    let outputTruncated = initialBuffer.truncated;
    const completedResult = (): CommandResult | null => {
      const commandResult = parseCommandResult(output, resultMarker);
      if (!commandResult) return null;
      onObservation?.({
        id: terminalId,
        status: "exited",
        updatedAt: Date.now(),
        exitCode: commandResult.exitCode,
      });
      closeOnce();
      return {
        outcome: "exited",
        ...commandResult,
        ...(outputTruncated ? { outputTruncated: true as const } : {}),
      };
    };
    while (true) {
      if (signal?.aborted) {
        closeOnce();
        return { outcome: "aborted" };
      }
      if (deadline <= Date.now()) {
        closeOnce();
        return { outcome: "timed_out" };
      }
      const bufferedResult = completedResult();
      if (bufferedResult) return bufferedResult;

      const statusResult = await this.bounded(
        () => this.terminals().get({ terminalId, signal }),
        deadline,
        signal,
      );
      if (statusResult.outcome === "aborted") {
        closeOnce();
        return { outcome: "aborted" };
      }
      if (statusResult.outcome === "timed_out") {
        closeOnce();
        return { outcome: "timed_out" };
      }
      const status = statusResult.value;
      onObservation?.({ id: terminalId, status: status.status, updatedAt: Date.now(), exitCode: status.exitCode });
      if (status.status === "exited") {
        closeOnce();
        return {
          outcome: "exited",
          exitCode: status.exitCode ?? 1,
          output,
          ...(outputTruncated ? { outputTruncated: true as const } : {}),
        };
      }

      const outputResult = await this.bounded(
        () => this.collect(terminalId, nextSeq, maximumBytes, signal),
        deadline,
        signal,
      );
      if (outputResult.outcome === "aborted") {
        closeOnce();
        return { outcome: "aborted" };
      }
      if (outputResult.outcome === "timed_out") {
        closeOnce();
        return { outcome: "timed_out" };
      }
      nextSeq = outputResult.value.nextSeq;
      const appended = appendBounded(output, outputResult.value.output, maximumBytes);
      output = appended.output;
      outputTruncated ||= outputResult.value.truncated || appended.truncated;
      const streamedResult = completedResult();
      if (streamedResult) return streamedResult;

      try {
        const remaining = deadline - Date.now();
        const delayResult = await this.bounded(
          () => abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), signal),
          deadline,
          signal,
        );
        if (delayResult.outcome === "aborted") {
          closeOnce();
          return { outcome: "aborted" };
        }
        if (delayResult.outcome === "timed_out") {
          closeOnce();
          return { outcome: "timed_out" };
        }
      } catch {
        closeOnce();
        return { outcome: "aborted" };
      }
    }
  }

  private async waitForStdinReady(
    terminalId: string,
    marker: string,
    deadline: number,
    signal: AbortSignal | undefined,
    closeOnce: () => void,
    maximumBytes: number,
  ): Promise<
    | Readonly<{ outcome: "ready"; buffer: TerminalOutputBuffer }>
    | Readonly<{ outcome: "timed_out" | "aborted" }>
  > {
    let nextSeq = 0;
    let output = "";
    let outputTruncated = false;
    const readyMarker = `${marker}_STDIN_READY`;
    while (true) {
      if (signal?.aborted) {
        closeOnce();
        return { outcome: "aborted" };
      }
      if (deadline <= Date.now()) {
        closeOnce();
        return { outcome: "timed_out" };
      }
      const outputResult = await this.bounded(
        () => this.collect(terminalId, nextSeq, maximumBytes, signal),
        deadline,
        signal,
      );
      if (outputResult.outcome !== "value") {
        closeOnce();
        return { outcome: outputResult.outcome };
      }
      nextSeq = outputResult.value.nextSeq;
      const appended = appendBounded(output, outputResult.value.output, maximumBytes);
      output = appended.output;
      outputTruncated ||= outputResult.value.truncated || appended.truncated;
      const readyMarkerStart = output.indexOf(readyMarker);
      if (readyMarkerStart !== -1) {
        const markerEnd = readyMarkerStart + readyMarker.length;
        const suffixStart = output.startsWith("\r\n", markerEnd)
          ? markerEnd + 2
          : output.startsWith("\n", markerEnd)
            ? markerEnd + 1
            : markerEnd;
        return {
          outcome: "ready",
          buffer: {
            nextSeq,
            output: output.slice(suffixStart),
            truncated: outputTruncated,
          },
        };
      }

      const statusResult = await this.bounded(
        () => this.terminals().get({ terminalId, signal }),
        deadline,
        signal,
      );
      if (statusResult.outcome !== "value") {
        closeOnce();
        return { outcome: statusResult.outcome };
      }
      if (statusResult.value.status === "exited") {
        closeOnce();
        throw new Error("terminal command exited before it accepted stdin");
      }
      const delayResult = await this.bounded(
        () => abortableDelay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()), signal),
        deadline,
        signal,
      );
      if (delayResult.outcome !== "value") {
        closeOnce();
        return { outcome: delayResult.outcome };
      }
    }
  }

  public async run(input: TerminalRunInput): Promise<CommandResult> {
    if (input.signal?.aborted) return { outcome: "aborted" };
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a finite non-negative number");
    }
    const maximumBytes = input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_OUTPUT_BYTES) {
      throw new TypeError(`maxOutputBytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}`);
    }
    if (
      input.stdin !== undefined &&
      (typeof input.stdin !== "string" || Buffer.byteLength(input.stdin, "utf8") > 1_048_576)
    ) {
      throw new TypeError("stdin must be a string of at most 1048576 UTF-8 bytes");
    }
    const deadline = Date.now() + input.timeoutMs;
    let terminalId: string | null = null;
    let closed = false;
    const closeOnce = () => {
      if (!terminalId || closed) return;
      closed = true;
      this.closeWithoutWaiting(terminalId);
    };
    const startResult = await this.bounded(
      () => this.start(input),
      deadline,
      input.signal,
      (lateSession) => {
        terminalId = lateSession.id;
        closeOnce();
      },
    );
    if (startResult.outcome === "aborted") return { outcome: "aborted" };
    if (startResult.outcome === "timed_out") return { outcome: "timed_out" };
    terminalId = startResult.value.id;
    input.onObservation?.({ id: terminalId, status: "starting", updatedAt: Date.now() });
    let initialBuffer = EMPTY_TERMINAL_OUTPUT;
    if (input.stdin !== undefined) {
      const stdin = input.stdin;
      const ready = await this.waitForStdinReady(
        terminalId,
        startResult.value.marker,
        deadline,
        input.signal,
        closeOnce,
        maximumBytes,
      );
      if (ready.outcome !== "ready") return ready;
      initialBuffer = ready.buffer;
      const sent = await this.bounded(
        () => this.terminals().input({
          terminalId: terminalId as string,
          dataBase64: Buffer.from(stdin, "utf8").toString("base64"),
        }),
        deadline,
        input.signal,
      );
      if (sent.outcome !== "value") {
        closeOnce();
        return { outcome: sent.outcome };
      }
    }
    return this.waitForExit(
      terminalId,
      deadline,
      input.signal,
      closeOnce,
      startResult.value.marker,
      maximumBytes,
      input.onObservation,
      initialBuffer,
    );
  }
}
