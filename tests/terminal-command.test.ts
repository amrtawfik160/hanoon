import { afterEach, describe, expect, test, vi } from "vitest";
import { parseCommandJson, TerminalCommandRunner } from "../src/bb/terminal-command";

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
  test("parses JSON after terminal control sequences without changing printable content", () => {
    const title = "Issue ; [brackets] \\ escapes and } braces";
    const output = `\u001b[?25l;?\u001b[?25h${JSON.stringify([{ title }])}`;

    expect(parseCommandJson(output, "audit: bug backlog")).toEqual([{ title }]);
  });

  test("describes a missing JSON payload in terms the audit can report", () => {
    expect(() => parseCommandJson("\u001b[?25l;? not JSON", "audit: bug backlog")).toThrow(
      "audit: bug backlog: command output did not contain a valid JSON payload",
    );
  });

  test("captures a command result before BB removes scrollback for an exited terminal", async () => {
    let marker: string | null = null;
    let statusReads = 0;
    const create = vi.fn().mockImplementation(async ({ start }: { start: { command: string } }) => {
      marker = start.command.match(/__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/)?.[0] ?? null;
      return { id: "terminal-1" };
    });
    const get = vi.fn().mockImplementation(async () => {
      statusReads += 1;
      return statusReads === 1
        ? { status: "running", exitCode: null, closeReason: null }
        : { status: "exited", exitCode: 1, closeReason: "process-exit" };
    });
    const output = vi.fn().mockImplementation(async () => {
      if (statusReads > 1) {
        throw Object.assign(new Error("Terminal output is unavailable"), {
          code: "terminal_output_unavailable",
          status: 409,
        });
      }
      expect(marker).not.toBeNull();
      return {
        chunks: [{ seq: 0, dataBase64: encoded(`user output\n${marker}:17\n`) }],
        nextSeq: 1,
        truncated: false,
      };
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const sdk = makeSdk({ create, get, output, close });
    const runner = new TerminalCommandRunner(sdk as never);

    const result = await runner.run({
      scope: { kind: "host_path", hostId: "host-1", cwd: "/workspace/project" },
      title: "fast command",
      command: `printf "%s" "owner's repo"`,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ outcome: "exited", exitCode: 17, output: "user output" });
    expect(output).toHaveBeenCalledWith({
      terminalId: "terminal-1",
      sinceSeq: 0,
      tailBytes: 65_536,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("emits a final exited observation when the result marker arrives before BB status", async () => {
    let marker: string | null = null;
    const observations: Array<{ status: string; exitCode?: number | null }> = [];
    const create = vi.fn().mockImplementation(async ({ start }: { start: { command: string } }) => {
      marker = start.command.match(/__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/)?.[0] ?? null;
      return { id: "terminal-1" };
    });
    const get = vi.fn().mockResolvedValue({ status: "running", exitCode: null });
    const output = vi.fn().mockImplementation(async () => ({
      chunks: [{ seq: 0, dataBase64: encoded(`ok\n${marker}:0\n`) }],
      nextSeq: 1,
    }));
    const runner = new TerminalCommandRunner(makeSdk({ create, get, output }) as never);

    const result = await runner.run({
      scope: { kind: "environment", environmentId: "env-1" },
      title: "validation",
      command: "npm test",
      timeoutMs: 5_000,
      onObservation: (observation) => observations.push(observation),
    });

    expect(result).toEqual({ outcome: "exited", exitCode: 0, output: "ok" });
    expect(observations.at(-1)).toMatchObject({ id: "terminal-1", status: "exited", exitCode: 0 });
  });

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
        start: { mode: "command", command: expect.stringContaining("git status --short") },
        title,
      });
      expect(get).toHaveBeenNthCalledWith(1, { terminalId: "terminal-1" });
      expect(get).toHaveBeenNthCalledWith(2, { terminalId: "terminal-1" });
      expect(output).toHaveBeenCalledWith({ terminalId: "terminal-1", sinceSeq: 0, tailBytes: 65_536 });
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

  describe("Task 8 round 1: shared lifecycle deadlines", () => {
    test.each(["create", "get", "output"] as const)(
      "bounds a %s SDK promise that ignores abort and closes known sessions without waiting",
      async (blockedStage) => {
        vi.useFakeTimers();
        const never = () => new Promise<never>(() => undefined);
        const create =
          blockedStage === "create"
            ? vi.fn().mockImplementation(never)
            : vi.fn().mockResolvedValue({ id: "terminal-1" });
        const get =
          blockedStage === "get"
            ? vi.fn().mockImplementation(never)
            : blockedStage === "output"
              ? vi.fn().mockResolvedValue({ status: "running", exitCode: null })
              : vi.fn().mockResolvedValue({ status: "exited", exitCode: 0 });
        const output =
          blockedStage === "output"
            ? vi.fn().mockImplementation(never)
            : vi.fn().mockResolvedValue({ chunks: [] });
        const close = vi.fn().mockImplementation(never);
        const sdk = makeSdk({ create, get, output, close });
        const runner = new TerminalCommandRunner(sdk as never);
        const timeoutMs = 100;
        const pending = runner.run({
          scope: { kind: "environment", environmentId: "env-1" },
          title: "bounded",
          command: "ignored-signal-command",
          timeoutMs,
        });
        const guard = new Promise<"guard">((resolve) => {
          setTimeout(() => resolve("guard"), timeoutMs * 2);
        });

        await vi.advanceTimersByTimeAsync(timeoutMs * 2);
        const result = await Promise.race([pending, guard]);

        expect(result).not.toBe("guard");
        expect(result).toEqual({ outcome: "timed_out" });
        if (blockedStage !== "create") expect(close).toHaveBeenCalledTimes(1);
      },
    );

    test("returns aborted for an in-flight ignored SDK promise and closes once", async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const get = vi.fn().mockImplementation(() => new Promise<never>(() => undefined));
      const close = vi.fn().mockImplementation(() => new Promise<never>(() => undefined));
      const sdk = makeSdk({ get, close });
      const runner = new TerminalCommandRunner(sdk as never);
      const pending = runner.run({
        scope: { kind: "environment", environmentId: "env-1" },
        title: "aborted",
        command: "ignored-abort-command",
        timeoutMs: 1_000,
        signal: controller.signal,
      });

      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      const guard = new Promise<"guard">((resolve) => {
        setTimeout(() => resolve("guard"), 100);
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await Promise.race([pending, guard]);

      expect(result).not.toBe("guard");
      expect(result).toEqual({ outcome: "aborted" });
      expect(close).toHaveBeenCalledTimes(1);
    });

    test("closes an exited session without requesting scrollback that BB has already removed", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      const sdk = makeSdk({
        get: vi.fn().mockResolvedValue({ status: "exited", exitCode: 0 }),
        output: vi.fn().mockResolvedValue({ chunks: [{ sequence: 1, data: encoded("done") }] }),
        close,
      });
      const runner = new TerminalCommandRunner(sdk as never);

      const result = await runner.run({
        scope: { kind: "environment", environmentId: "env-1" },
        title: "normal-exit",
        command: "echo done",
        timeoutMs: 1_000,
      });

      expect(result).toEqual({ outcome: "exited", exitCode: 0, output: "" });
      expect(sdk.terminals.output).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
