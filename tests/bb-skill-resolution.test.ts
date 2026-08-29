import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const bbServer = join(repositoryRoot, "node_modules", "bb-app", "dist", "bb-server.js");
const bbCli = join(repositoryRoot, "node_modules", "bb-app", "dist", "bb.js");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("BB integration test could not reserve a port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function boundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-16_384);
}

async function waitForServer(url: string, process: ChildProcessWithoutNullStreams, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`isolated BB exited before readiness\n${diagnostics()}`);
    try {
      const response = await fetch(`${url}/api/v1/plugins`);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`isolated BB did not become ready\n${diagnostics()}`);
}

async function stopServer(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exit = new Promise<boolean>((resolve) => process.once("exit", () => resolve(true)));
  process.kill("SIGINT");
  const stopped = await Promise.race([
    exit,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (stopped) return;
  process.kill("SIGKILL");
  await exit;
}

test("real BB loads one plugin source for every expansion skill id", async () => {
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const dataDir = join(tmpdir(), `bb-skill-resolution-${process.pid}-${port}`);
  mkdirSync(dataDir);
  let stdout = "";
  let stderr = "";
  const server = spawn(process.execPath, [
    bbServer,
    "--data-dir",
    dataDir,
    "--server-bind-host",
    "127.0.0.1",
    "--server-port",
    String(port),
  ], { cwd: repositoryRoot, stdio: "pipe" });
  server.stdout.on("data", (chunk: Buffer) => { stdout = boundedOutput(stdout, chunk); });
  server.stderr.on("data", (chunk: Buffer) => { stderr = boundedOutput(stderr, chunk); });
  const diagnostics = () => `${stdout}\n${stderr}`.trim();

  try {
    await waitForServer(serverUrl, server, diagnostics);
    const cliEnvironment: NodeJS.ProcessEnv = { ...process.env, BB_SERVER_URL: serverUrl };
    delete cliEnvironment.BB_CLI;
    const installed = spawnSync(process.execPath, [
      bbCli,
      "plugin",
      "install",
      "path:.",
      "--yes",
      "--json",
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: cliEnvironment,
      timeout: 90_000,
    });
    expect(
      installed.status,
      `${installed.error?.message ?? ""}\n${installed.stderr}\n${diagnostics()}`,
    ).toBe(0);
    const result = JSON.parse(installed.stdout) as {
      plugin: { status: string; capabilities: Array<{ kind: string; id: string }> };
    };
    const skillIds = result.plugin.capabilities
      .filter((capability) => capability.kind === "skill")
      .map((capability) => capability.id);

    expect(result.plugin.status).not.toBe("error");
    expect(skillIds).toHaveLength(50);
    expect(new Set(skillIds).size).toBe(50);
    expect(skillIds.filter((id) => ["domain-modeling", "grill-with-docs", "grilling"].includes(id)))
      .toEqual(["domain-modeling", "grill-with-docs", "grilling"]);
  } finally {
    await stopServer(server);
  }
}, 120_000);
