#!/usr/bin/env node
/**
 * Secret-free recorder/validator for the credential broker acceptance report
 * defined in `src/eval/credential-broker-acceptance.ts`. This script never
 * talks to a broker, a vault provider, or BB — it only reads and writes one
 * local JSON report file against the fixed case corpus in
 * `evals/credential-broker-cases.json`, and every value it accepts is run
 * through that module's schema before anything is written.
 *
 *   node scripts/record-credential-broker-acceptance.mjs init --output <absolute-path> [--replace]
 *   node scripts/record-credential-broker-acceptance.mjs record --input <absolute-path> --case <id> \
 *     --status <passed|failed|incomplete> --cleanup <not_applicable|pending|complete> \
 *     --procedure-revision <n> [--started-at <epoch-ms>] [--completed-at <epoch-ms>] \
 *     [--actor <text>] [--reviewer <text>] [--actual-result <text>] \
 *     [--evidence <ref>]... [--resource <id>]... [--output <absolute-path>]
 *   node scripts/record-credential-broker-acceptance.mjs validate --input <absolute-path>
 *
 * `--output`/`--input` must be absolute and outside this repository. They are
 * accepted under `$BB_THREAD_STORAGE`, or elsewhere only with
 * `--protected-operator-path` confirming the operator placed it on a
 * protected path they control.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIncompleteCredentialAcceptanceReport,
  evaluateCredentialAcceptanceReport,
  parseCredentialAcceptanceCaseCorpus,
  parseCredentialAcceptanceReport,
} from "../src/eval/credential-broker-acceptance.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CORPUS_PATH = join(pluginRoot, "evals/credential-broker-cases.json");
const REPORT_FILE_MODE = 0o600;

function fail(message) {
  process.stderr.write(`credential-broker-acceptance: ${message}\n`);
  process.exit(1);
}

function loadCorpus(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`could not read case corpus at ${path}`);
  }
  try {
    return parseCredentialAcceptanceCaseCorpus(JSON.parse(raw));
  } catch (error) {
    fail(`case corpus at ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Refuses a path that is relative, or that is not under `$BB_THREAD_STORAGE` and not explicitly attested as a protected operator path — and always refuses one inside this repository. */
function assertProtectedOutputPath(path, flagName, acknowledgedProtectedPath) {
  if (!isAbsolute(path)) fail(`${flagName} must be an absolute path`);
  if (path === pluginRoot || path.startsWith(`${pluginRoot}${sep}`)) {
    fail(`${flagName} must be outside this repository; a generated report is never committed`);
  }
  const threadStorage = process.env.BB_THREAD_STORAGE;
  const underThreadStorage = Boolean(threadStorage) && isAbsolute(threadStorage) &&
    (path === threadStorage || path.startsWith(threadStorage.endsWith(sep) ? threadStorage : `${threadStorage}${sep}`));
  if (!underThreadStorage && !acknowledgedProtectedPath) {
    fail(`${flagName} must be under $BB_THREAD_STORAGE, or pass --protected-operator-path to confirm ${path} is a protected operator path you control`);
  }
}

function readArguments(argv, spec) {
  const values = {};
  const repeatable = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected positional argument ${token}`);
    const name = token.slice(2);
    const kind = spec[name];
    if (kind === undefined) fail(`unknown flag --${name}`);
    if (kind === "boolean") {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
    index += 1;
    if (kind === "repeatable") {
      repeatable[name] = [...(repeatable[name] ?? []), value];
      continue;
    }
    values[name] = value;
  }
  return { values, repeatable, flags };
}

function parseEpochMillis(raw, flagName) {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${flagName} must be a nonnegative integer epoch-millisecond timestamp`);
  return value;
}

function writeReport(path, report, replace) {
  const content = `${JSON.stringify(report, null, 2)}\n`;
  try {
    writeFileSync(path, content, { mode: REPORT_FILE_MODE, flag: replace ? "w" : "wx" });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      fail(`${path} already exists; pass --replace to overwrite it`);
    }
    fail(`could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  chmodSync(path, REPORT_FILE_MODE);
}

function runInit(argv) {
  const { values, flags } = readArguments(argv, {
    output: "single",
    corpus: "single",
    "generated-at": "single",
    replace: "boolean",
    "protected-operator-path": "boolean",
  });
  if (!values.output) fail("init requires --output <absolute-path>");
  assertProtectedOutputPath(values.output, "--output", flags.has("protected-operator-path"));
  const corpus = loadCorpus(values.corpus ?? DEFAULT_CORPUS_PATH);
  const generatedAt = parseEpochMillis(values["generated-at"], "--generated-at") ?? Date.now();
  const report = buildIncompleteCredentialAcceptanceReport(corpus, generatedAt);
  writeReport(values.output, report, flags.has("replace"));
  process.stdout.write(`initialized ${values.output} status=${report.status} cases=${report.cases.length}\n`);
}

function runRecord(argv) {
  const { values, repeatable, flags } = readArguments(argv, {
    input: "single",
    output: "single",
    corpus: "single",
    case: "single",
    status: "single",
    cleanup: "single",
    "procedure-revision": "single",
    "started-at": "single",
    "completed-at": "single",
    actor: "single",
    reviewer: "single",
    "actual-result": "single",
    "generated-at": "single",
    evidence: "repeatable",
    resource: "repeatable",
    "protected-operator-path": "boolean",
  });
  if (!values.input) fail("record requires --input <absolute-path>");
  if (!values.case) fail("record requires --case <id>");
  if (!values.status) fail("record requires --status <passed|failed|incomplete>");
  if (!values.cleanup) fail("record requires --cleanup <not_applicable|pending|complete>");
  if (!values["procedure-revision"]) fail("record requires --procedure-revision <n>");
  const outputPath = values.output ?? values.input;
  assertProtectedOutputPath(values.input, "--input", flags.has("protected-operator-path"));
  if (outputPath !== values.input) assertProtectedOutputPath(outputPath, "--output", flags.has("protected-operator-path"));

  const corpus = loadCorpus(values.corpus ?? DEFAULT_CORPUS_PATH);
  if (!existsSync(values.input)) fail(`${values.input} does not exist; run init first`);
  let existing;
  try {
    existing = parseCredentialAcceptanceReport(JSON.parse(readFileSync(values.input, "utf8")), corpus);
  } catch (error) {
    fail(`${values.input} is not a valid report: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!corpus.cases.some((definition) => definition.id === values.case)) {
    fail(`${values.case} is not a case defined in the corpus`);
  }

  const procedureRevision = Number(values["procedure-revision"]);
  if (!Number.isSafeInteger(procedureRevision) || procedureRevision < 1) fail("--procedure-revision must be a positive integer");

  const updatedEntry = {
    id: values.case,
    status: values.status,
    cleanupStatus: values.cleanup,
    procedureRevision,
    startedAt: parseEpochMillis(values["started-at"], "--started-at"),
    completedAt: parseEpochMillis(values["completed-at"], "--completed-at"),
    actor: values.actor ?? null,
    reviewer: values.reviewer ?? null,
    actualResult: values["actual-result"] ?? null,
    evidenceRefs: repeatable.evidence ?? [],
    disposableResourceIds: repeatable.resource ?? [],
  };
  const cases = existing.cases.map((entry) => entry.id === values.case ? updatedEntry : entry);
  const generatedAt = parseEpochMillis(values["generated-at"], "--generated-at") ?? Date.now();
  const evaluation = evaluateCredentialAcceptanceReport({ corpus, cases });

  let updatedReport;
  try {
    updatedReport = parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt, status: evaluation.status, cases },
      corpus,
    );
  } catch (error) {
    fail(`recorded case would make the report invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeReport(outputPath, updatedReport, true);
  process.stdout.write(`recorded ${values.case} in ${outputPath} case_status=${values.status} report_status=${updatedReport.status}\n`);
}

function runValidate(argv) {
  const { values } = readArguments(argv, { input: "single", corpus: "single" });
  if (!values.input) fail("validate requires --input <absolute-path>");
  const corpus = loadCorpus(values.corpus ?? DEFAULT_CORPUS_PATH);
  let report;
  try {
    report = parseCredentialAcceptanceReport(JSON.parse(readFileSync(values.input, "utf8")), corpus);
  } catch (error) {
    fail(`${values.input} is not a valid report: ${error instanceof Error ? error.message : String(error)}`);
  }
  const evaluation = evaluateCredentialAcceptanceReport({ corpus, cases: report.cases });
  const lines = [
    `status=${evaluation.status}`,
    `cases=${report.cases.length}`,
    `missing=${evaluation.missingCaseIds.length}`,
    `unmet_mandatory=${evaluation.unmetMandatoryIds.length}`,
    `missing_counterparts=${evaluation.missingCounterpartIds.length}`,
  ];
  process.stdout.write(`${lines.join(" ")}\n`);
  if (evaluation.status !== "passed") {
    for (const id of evaluation.missingCaseIds) process.stdout.write(`  missing case: ${id}\n`);
    for (const id of evaluation.unmetMandatoryIds) process.stdout.write(`  unmet mandatory case: ${id}\n`);
    for (const id of evaluation.missingCounterpartIds) process.stdout.write(`  missing red-state counterpart: ${id}\n`);
    process.exit(1);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "init") return runInit(rest);
  if (command === "record") return runRecord(rest);
  if (command === "validate") return runValidate(rest);
  fail(`unknown command ${command ?? "<none>"}; expected init, record, or validate`);
}

main();
