import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminalCommandRunner } from "../src/bb/terminal-command";

type TerminalSdk = {
  terminals: {
    create: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    output: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
};

const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64");

function makeSdk(overrides: Partial<TerminalSdk["terminals"]> = {}): TerminalSdk {
  return {
    terminals: {
      create: vi.fn().mockResolvedValue({ id: "terminal-1" }),
      get: vi.fn().mockResolvedValue({ status: "exited", exitCode: 0 }),
      output: vi.fn().mockResolvedValue({ chunks: [] }),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalCommandRunner", () => {
  test.each([
    {
      scope: { kind: "environment", environmentId: "env-1" } as const,
      title: "environment command",
    },
    {
      scope: { kind: "host_path", hostId: "host-1", cwd: "/workspace/project" } as const,
      title: "host command",
    },
  ])(
    "starts a bounded command with the exact $scope scope and preserves its exit result",
    async ({ scope, title }) => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ status: "exited", exitCode: 17 });
      const output = vi.fn().mockResolvedValue({
        chunks: [
          { sequence: 2, data: encoded("\u001b[32msecond\u001b[0m") },
          { sequence: 1, data: encoded("first ") },
        ],
      });
      const sdk = makeSdk({ create: vi.fn().mockResolvedValue({ id: "terminal-1" }), get, output });
      const runner = new TerminalCommandRunner(sdk as never);

      const result = await runner.run({
        scope,
        title,
        command: "git status --short",
        timeoutMs: 5_000,
      });

      expect(sdk.terminals.create).toHaveBeenCalledWith({
        cols: 120,
        rows: 40,
        scope,
        start: { mode: "command", command: "git status --short" },
        title,
      });
      expect(get).toHaveBeenNthCalledWith(1, { terminalId: "terminal-1" });
      expect(get).toHaveBeenNthCalledWith(2, { terminalId: "terminal-1" });
      expect(output).toHaveBeenCalledWith({ terminalId: "terminal-1", tailBytes: 65_536 });
      expect(result).toEqual({
        outcome: "exited",
        exitCode: 17,
        output: "first second",
      });
    },
  );

  test("returns a timeout outcome and force-closes the session exactly once", async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValue({ status: "running" });
    const close = vi.fn().mockResolvedValue(undefined);
    const sdk = makeSdk({ get, close });
    const runner = new TerminalCommandRunner(sdk as never);

    const pending = runner.run({
      scope: { kind: "environment", environmentId: "env-1" },
      title: "timeout",
      command: "long-running-command",
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ terminalId: "terminal-1", mode: "force" });
    expect(result).toEqual({ outcome: "timed_out" });
  });

  test("honors an already-aborted signal without starting a terminal", async () => {
    const sdk = makeSdk();
    const runner = new TerminalCommandRunner(sdk as never);
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run({
      scope: { kind: "environment", environmentId: "env-1" },
      title: "aborted",
      command: "must-not-start",
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    expect(sdk.terminals.create).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "aborted" });
  });
});
