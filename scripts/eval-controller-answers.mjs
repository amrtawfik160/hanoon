#!/usr/bin/env node
/**
 * Opt-in answer-quality evaluation.
 *
 * Deliberately NOT part of `npm run check`: grading costs one provider turn per
 * case, and the deterministic suite must stay runnable offline and for free.
 *
 * The plugin SDK has no direct model call, so the judge runs the same way every
 * other model in this system does — as a BB thread, driven through the `bb`
 * CLI. That also means this needs a working `bb` with a usable provider.
 *
 *   node scripts/eval-controller-answers.mjs --project <project-id> [--model <id>] [--case <id>]
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildJudgePrompt, parseAnswerVerdict } from "../src/eval/answer-contract.ts";

const run = promisify(execFile);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = join(pluginRoot, "evals/answers.json");
const WAIT_SECONDS = 180;

function fail(message) {
  process.stderr.write(`answer eval: ${message}\n`);
  process.exit(1);
}

function readArguments(argv) {
  const options = { project: null, model: null, only: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--project" && value) { options.project = value; index += 1; continue; }
    if (flag === "--model" && value) { options.model = value; index += 1; continue; }
    if (flag === "--case" && value) { options.only = value; index += 1; continue; }
    fail(`unknown argument ${flag}`);
  }
  if (!options.project) fail("--project <project-id> is required");
  return options;
}

async function bb(args) {
  const { stdout } = await run("bb", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** One judge thread per case, so no case can contaminate another's grading. */
async function judge(options, testCase) {
  const prompt = buildJudgePrompt({ ownerMessage: testCase.ownerMessage, answer: testCase.answer });
  const spawnArgs = [
    "thread", "spawn",
    "--project", options.project,
    "--title", `answer-eval ${testCase.id}`,
    "--message", prompt,
    "--json",
  ];
  if (options.model) spawnArgs.push("--model", options.model);
  const spawned = JSON.parse(await bb(spawnArgs));
  const threadId = spawned?.thread?.id ?? spawned?.id;
  if (!threadId) throw new Error("bb thread spawn did not return a thread id");
  try {
    await bb(["thread", "wait", threadId, "--status", "idle", "--timeout", String(WAIT_SECONDS), "--json"]);
  } catch {
    throw new Error(`judge thread ${threadId} did not finish within ${WAIT_SECONDS}s`);
  }
  const verdict = parseAnswerVerdict(await bb(["thread", "output", threadId]));
  if (!verdict) throw new Error(`judge thread ${threadId} did not return a usable verdict`);
  return verdict;
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  const { cases } = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  const selected = options.only ? cases.filter((each) => each.id === options.only) : cases;
  if (selected.length === 0) fail(`no case matched ${options.only}`);

  let agreed = 0;
  const disagreements = [];
  for (const testCase of selected) {
    let verdict;
    try {
      verdict = await judge(options, testCase);
    } catch (error) {
      disagreements.push({ id: testCase.id, detail: error instanceof Error ? error.message : "judge failed" });
      process.stdout.write(`  ERROR  ${testCase.id}\n`);
      continue;
    }
    const actual = verdict.passed ? "pass" : "fail";
    const broken = verdict.clauses.filter((clause) => !clause.holds).map((clause) => clause.id);
    if (actual === testCase.expect) {
      agreed += 1;
      process.stdout.write(`  ok     ${testCase.id} (${actual})${broken.length ? ` [${broken.join(", ")}]` : ""}\n`);
      continue;
    }
    disagreements.push({ id: testCase.id, detail: `expected ${testCase.expect}, judged ${actual}` });
    process.stdout.write(`  MISS   ${testCase.id}: expected ${testCase.expect}, judged ${actual}\n`);
  }

  process.stdout.write(`\nrubric agreement ${agreed}/${selected.length}\n`);
  if (disagreements.length > 0) {
    // A rubric that misgrades its own golden cases cannot be trusted to grade a
    // prompt change, so this is a failure of the harness, not a soft warning.
    process.stdout.write("the rubric disagreed with its golden cases; recalibrate before trusting it\n");
    process.exit(1);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
