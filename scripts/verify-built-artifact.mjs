#!/usr/bin/env node
// The build emits a single bundled server.js. Nothing else in the test suite
// imports that file, so a specifier that survives bundling — a dynamic import of
// a source path, say — fails only at activation, on the owner's machine, after a
// successful build. This loads the real artifact the way BB would and asserts
// the two exports activation needs, without calling the plugin factory.
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(root, "dist/server.js");

function fail(message) {
  process.stderr.write(`built artifact check: ${message}\n`);
  process.exit(1);
}

let plugin;
try {
  plugin = await import(pathToFileURL(artifact).href);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
  const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
  fail(`dist/server.js could not be imported${code}: ${detail.slice(0, 200)}`);
}

const missing = ["default", "activatePlugin"].filter((name) => plugin[name] === undefined);
if (missing.length > 0) fail(`dist/server.js is missing ${missing.join(" and ")}`);
if (typeof plugin.activatePlugin !== "function") fail("dist/server.js activatePlugin is not callable");

// Deliberately not invoked: activation touches storage, services, and Telegram.
process.stdout.write("builtArtifact=dist/server.js exports=default,activatePlugin\n");
