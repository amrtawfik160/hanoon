import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";

export type TerminalScope =
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; hostId: string; cwd: string | null };

export type CommandResult =
  | { outcome: "exited"; exitCode: number; output: string }
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
  timeoutMs: number;
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
  close(input: { terminalId: string; mode: "force" }): Promise<unknown>;
};

type BbSdk = BbPluginApi["sdk"];

type BoundedResult<T> =
  | { outcome: "value"; value: T }
  | { outcome: "timed_out" }
  | { outcome: "aborted" };

const POLL_INTERVAL_MS = 250;
const TAIL_BYTES = 65_536;
const RESULT_MARKER_PREFIX = "__BB_TELEGRAM_AGENT_RESULT_";

function stripAnsi(terminalOutput: string): string {
  return terminalOutput
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
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

function commandEnvelope(command: string, marker: string): string {
  if (command.includes("\0")) throw new TypeError("command must not contain NUL bytes");
  return [
    `__bb_telegram_agent_command=${shellSingleQuote(command)}`,
    '"${SHELL:-/bin/sh}" -lc "$__bb_telegram_agent_command"',
    "__bb_telegram_agent_exit=$?",
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

function appendBounded(current: string, next: string): string {
  const bytes = Buffer.from(current + next, "utf8");
  return bytes.length <= TAIL_BYTES ? bytes.toString("utf8") : bytes.subarray(bytes.length - TAIL_BYTES).toString("utf8");
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

  private async collect(terminalId: string, sinceSeq: number, signal?: AbortSignal): Promise<{ nextSeq: number; output: string }> {
    const result = await this.terminals().output({ terminalId, sinceSeq, tailBytes: TAIL_BYTES, signal });
    return {
      nextSeq: result.nextSeq ?? sinceSeq,
      output: collectOutput(result.chunks),
    };
  }

  private async start(input: TerminalRunInput): Promise<{ id: string; marker: string }> {
    const marker = `${RESULT_MARKER_PREFIX}${randomBytes(16).toString("hex")}__`;
    const session = await this.terminals().create({
      cols: 120,
      rows: 40,
      scope: input.scope,
      start: { mode: "command", command: commandEnvelope(input.command, marker) },
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
    onObservation?: (observation: TerminalObservation) => void,
  ): Promise<CommandResult> {
    let nextSeq = 0;
    let output = "";
    while (true) {
      if (signal?.aborted) {
        closeOnce();
        return { outcome: "aborted" };
      }
      if (deadline <= Date.now()) {
        closeOnce();
        return { outcome: "timed_out" };
      }

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
        };
      }

      const outputResult = await this.bounded(() => this.collect(terminalId, nextSeq, signal), deadline, signal);
      if (outputResult.outcome === "aborted") {
        closeOnce();
        return { outcome: "aborted" };
      }
      if (outputResult.outcome === "timed_out") {
        closeOnce();
        return { outcome: "timed_out" };
      }
      nextSeq = outputResult.value.nextSeq;
      output = appendBounded(output, outputResult.value.output);
      const commandResult = parseCommandResult(output, resultMarker);
      if (commandResult) {
        onObservation?.({
          id: terminalId,
          status: "exited",
          updatedAt: Date.now(),
          exitCode: commandResult.exitCode,
        });
        closeOnce();
        return { outcome: "exited", ...commandResult };
      }

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

  public async run(input: TerminalRunInput): Promise<CommandResult> {
    if (input.signal?.aborted) return { outcome: "aborted" };
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a finite non-negative number");
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
    return this.waitForExit(terminalId, deadline, input.signal, closeOnce, startResult.value.marker, input.onObservation);
  }
}
