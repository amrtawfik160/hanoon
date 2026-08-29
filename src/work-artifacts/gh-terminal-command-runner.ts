import {
  shellSingleQuote,
  TerminalCommandRunner,
  type TerminalScope,
} from "../bb/terminal-command";
import type {
  GhCliCommandInput,
  GhCliCommandRunner,
} from "./gh-cli-issue-gateway";

export type TerminalGhCliCommandRunnerOptions = Readonly<{
  scope: TerminalScope;
  title?: string;
  timeoutMs?: number;
}>;

/** Runs argv-shaped GitHub commands in the project's BB terminal scope. */
export class TerminalGhCliCommandRunner implements GhCliCommandRunner {
  private readonly title: string;
  private readonly timeoutMs: number;

  public constructor(
    private readonly terminal: TerminalCommandRunner,
    private readonly options: TerminalGhCliCommandRunnerOptions,
  ) {
    this.title = options.title ?? "Hanoon GitHub tracker";
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  public async run(input: GhCliCommandInput): Promise<Readonly<{ stdout: string }>> {
    if (input.args.length === 0 || input.args[0] !== "gh") {
      throw new TypeError("GitHub tracker commands must invoke gh directly");
    }
    const command = input.args.map((argument) => shellSingleQuote(argument)).join(" ");
    const result = await this.terminal.run({
      scope: this.options.scope,
      title: this.title,
      command,
      stdin: input.stdin,
      timeoutMs: Math.min(input.timeoutMs ?? this.timeoutMs, this.timeoutMs),
      maxOutputBytes: input.maxCaptureBytes,
    });
    if (result.outcome === "timed_out") throw new Error("GitHub tracker command timed out");
    if (result.outcome === "aborted") throw new Error("GitHub tracker command was aborted");
    if (result.outputTruncated === true) {
      throw new Error("GitHub tracker command output exceeded its capture budget");
    }
    if (result.exitCode !== 0) {
      throw new Error(`GitHub tracker command exited with ${result.exitCode}: ${result.output.slice(-1_000)}`);
    }
    return { stdout: result.output.trim() };
  }
}
