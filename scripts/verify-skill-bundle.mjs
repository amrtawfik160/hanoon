#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySkillBundle } from "../src/agent-skills/bundle-integrity.js";

if (process.argv.length !== 2) throw new Error("Skill bundle verifier accepts no arguments");

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verified = verifySkillBundle(pluginRoot);
process.stdout.write(`bundleDigest=${verified.bundleDigest} skillCount=${verified.skillIds.length}\n`);
