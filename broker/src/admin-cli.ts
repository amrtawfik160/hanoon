#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ADMIN_MAX_LINE_BYTES, parseAdminRequest, parseAdminResponse, type AdminRequest, type AdminResponse } from "./admin-protocol.js";
import { ADMIN_SOCKET_ROOT } from "./config.js";

const DEFAULT_ADMIN_SOCKET_PATH = join(ADMIN_SOCKET_ROOT, "admin.sock");
const CLI_TIMEOUT_MS = 10_000;

export type AdminCliIo = Readonly<{
  socketPath: string;
  stdin?: string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}>;

class AdminCliError extends Error {
  constructor() {
    super("admin_command_failed");
    this.name = "AdminCliError";
  }
}

function readBoundedStdin(io: AdminCliIo): Record<string, unknown> {
  const input = io.stdin ?? readFileSync(0, "utf8");
  if (Buffer.byteLength(input, "utf8") > ADMIN_MAX_LINE_BYTES) throw new AdminCliError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new AdminCliError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AdminCliError();
  const fields = parsed as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(fields, "operation")) throw new AdminCliError();
  return fields;
}

function requestFromArguments(argv: readonly string[], io: AdminCliIo): AdminRequest {
  if (argv[0] === "installation" && argv[1] === "add" && argv.length === 3 && argv[2] === "--stdin") {
    return parseRequest({ operation: "installation.add", ...readBoundedStdin(io) });
  }
  if (argv[0] === "installation" && argv[1] === "attest" && argv.length === 4 && argv[3] === "--stdin") {
    return parseRequest({ operation: "installation.attest", installationId: argv[2], ...readBoundedStdin(io) });
  }
  if (argv[0] === "installation" && argv[1] === "revoke" && argv.length === 3) {
    return parseRequest({ operation: "installation.revoke", installationId: argv[2] });
  }
  if (argv[0] === "binding" && argv[1] === "add" && argv.length === 3 && argv[2] === "--stdin") {
    return parseRequest({ operation: "binding.add", ...readBoundedStdin(io) });
  }
  if (argv[0] === "binding" && argv[1] === "revoke" && argv.length === 4) {
    return parseRequest({ operation: "binding.revoke", installationId: argv[2], bindingId: argv[3] });
  }
  if (argv[0] === "connector" && argv[1] === "binding" && argv[2] === "enroll" && argv.length === 4 && argv[3] === "--stdin") {
    return parseRequest({ operation: "connector.binding.enroll", ...readBoundedStdin(io) });
  }
  if (argv[0] === "installation" && argv[1] === "doctor" && (argv.length === 3 || (argv.length === 4 && argv[3] === "--json"))) {
    return parseRequest({ operation: "installation.doctor", installationId: argv[2] });
  }
  if (argv[0] === "status" && (argv.length === 1 || (argv.length === 2 && argv[1] === "--json"))) {
    return parseRequest({ operation: "broker.status" });
  }
  throw new AdminCliError();
}

function parseRequest(input: unknown): AdminRequest {
  const parsed = parseAdminRequest(input);
  if (!parsed.ok) throw new AdminCliError();
  return parsed.value;
}

function sendAdminRequest(socketPath: string, request: AdminRequest): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    socket.setTimeout(CLI_TIMEOUT_MS, () => finish(() => {
      socket.destroy();
      reject(new AdminCliError());
    }));
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", () => finish(() => reject(new AdminCliError())));
    socket.once("close", () => finish(() => {
      const responseBytes = Buffer.concat(chunks);
      const newline = responseBytes.indexOf(0x0a);
      if (newline < 0 || responseBytes.subarray(newline + 1).length > 0) {
        reject(new AdminCliError());
        return;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(responseBytes.subarray(0, newline).toString("utf8"));
      } catch {
        reject(new AdminCliError());
        return;
      }
      const parsed = parseAdminResponse(parsedJson);
      if (!parsed.ok) {
        reject(new AdminCliError());
        return;
      }
      resolve(parsed.value);
    }));
  });
}

function safeResponseProjection(response: AdminResponse): Record<string, unknown> {
  if (!response.ok) return { ok: false, operation: response.operation, code: response.code };
  switch (response.operation) {
    case "installation.add":
    case "installation.attest":
    case "installation.revoke":
      return { ok: true, operation: response.operation, installationId: response.installationId, state: response.state };
    case "binding.add":
    case "binding.revoke":
      return {
        ok: true,
        operation: response.operation,
        installationId: response.installationId,
        bindingId: response.bindingId,
        state: response.state,
        generation: response.generation,
      };
    case "connector.binding.enroll":
      return {
        ok: true,
        operation: response.operation,
        installationId: response.installationId,
        projectId: response.projectId,
        bindingId: response.bindingId,
        state: response.state,
        generation: response.generation,
        projection: response.projection,
      };
    case "installation.doctor":
      return {
        ok: true,
        operation: response.operation,
        installationId: response.installationId,
        state: response.state,
        bindingCount: response.bindingCount,
        adapterState: response.adapterState,
        topologyReceiptState: response.topologyReceiptState,
      };
    case "broker.status":
      return {
        ok: true,
        operation: response.operation,
        schemaVersion: response.schemaVersion,
        brokerVersion: response.brokerVersion,
        installationCount: response.installationCount,
        bindingCount: response.bindingCount,
      };
  }
}

export function formatCliOutput(response: AdminResponse): string {
  return `${JSON.stringify(safeResponseProjection(response))}\n`;
}

export async function runAdminCli(
  argv: readonly string[],
  options: Partial<AdminCliIo> = {},
): Promise<number> {
  const io: AdminCliIo = {
    socketPath: options.socketPath ?? process.env.HANOON_BROKER_ADMIN_SOCKET ?? DEFAULT_ADMIN_SOCKET_PATH,
    stdin: options.stdin,
    writeStdout: options.writeStdout ?? ((text) => process.stdout.write(text)),
    writeStderr: options.writeStderr ?? ((text) => process.stderr.write(text)),
  };
  try {
    const request = requestFromArguments(argv, io);
    const response = await sendAdminRequest(io.socketPath, request);
    io.writeStdout(formatCliOutput(response));
    return response.ok ? 0 : 1;
  } catch {
    io.writeStderr("admin_command_failed\n");
    return 1;
  }
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runAdminCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
