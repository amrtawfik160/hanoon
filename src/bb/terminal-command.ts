import type { BbPluginApi } from "@bb/plugin-sdk";

export type TerminalScope =
  | { kind: "environment"; environmentId: string }
  | { kind: "host_path"; hostId: string; cwd: string | null };

export type CommandResult =
  | { outcome: "exited"; exitCode: number; output: string }
  | { outcome: "timed_out" }
  | { outcome: "aborted" };

export interface TerminalRunInput {
  scope: TerminalScope;
  title: string;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
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
  output(input: { terminalId: string; tailBytes: number; signal?: AbortSignal }): Promise<{
    chunks: Array<{ seq?: number; sequence?: number; dataBase64?: string; data?: string }>;
  }>;
  close(input: { terminalId: string; mode: "force" }): Promise<unknown>;
};

type BbSdk = BbPluginApi["sdk"];

const POLL_INTERVAL_MS = 250;
const TAIL_BYTES = 65_536;

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

  private async closeForcefully(terminalId: string): Promise<void> {
    try {
      await this.terminals().close({ terminalId, mode: "force" });
    } catch {
      // The caller already has a bounded outcome; a close race must not turn it into success.
    }
  }

  private async collect(terminalId: string, signal?: AbortSignal): Promise<string> {
    const result = await this.terminals().output({ terminalId, tailBytes: TAIL_BYTES, signal });
    return collectOutput(result.chunks);
  }

  private async start(input: TerminalRunInput): Promise<{ id: string }> {
    return this.terminals().create({
      cols: 120,
      rows: 40,
      scope: input.scope,
      start: { mode: "command", command: input.command },
      title: input.title,
    });
  }

  private async waitForExit(
    terminalId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (signal?.aborted) {
        await this.closeForcefully(terminalId);
        return { outcome: "aborted" };
      }

      const status = await this.terminals().get({ terminalId, signal });
      if (status.status === "exited") {
        return {
          outcome: "exited",
          exitCode: status.exitCode ?? 1,
          output: await this.collect(terminalId, signal),
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await this.closeForcefully(terminalId);
        return { outcome: "timed_out" };
      }

      try {
        await abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), signal);
      } catch {
        await this.closeForcefully(terminalId);
        return { outcome: "aborted" };
      }
    }
  }

  public async run(input: TerminalRunInput): Promise<CommandResult> {
    if (input.signal?.aborted) return { outcome: "aborted" };
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) {
      throw new TypeError("timeoutMs must be a finite non-negative number");
    }
    const session = await this.start(input);
    return this.waitForExit(session.id, input.timeoutMs, input.signal);
  }
}
