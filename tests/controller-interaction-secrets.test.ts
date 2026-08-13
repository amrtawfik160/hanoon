import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { BbControllerAdapter } from "../src/controller/bb-controller";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import { LunaControllerService } from "../src/controller/service";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import {
  isSafeControllerApprovalSummary,
  parseControllerInteraction,
  parseThreadInteraction,
  renderControllerInteraction,
} from "../src/controller/questions";
import { policyFixture } from "./helpers";
import type { ControllerEvidenceReconciler } from "../src/controller/evidence-projector";

const OWNER = "7";
const THREAD_ID = "thr_secret_controller";
const INTERACTION_ID = "pint_secret";
const CONTROLLER_KEY = createHash("sha256")
  .update(`telegram-controller:${OWNER}:${OWNER}`, "utf8")
  .digest("base64url")
  .slice(0, 32);

/**
 * One marker per field, so a leak names the exact field it came through rather
 * than merely proving that something leaked.
 */
const SECRETS = {
  prompt: "token: sk-promptleak0000000000",
  shortLabel: "token: sk-shortlabelleak000000",
  optionValue: "token: sk-optionvalueleak00000",
  optionLabel: "token: sk-optionlabelleak00000",
  optionDescription: "token: sk-optiondescleak0000000",
  approval: "token: sk-approvalleak000000000",
} as const;

const ALL_MARKERS = Object.values(SECRETS);

let hostNumber = 0;

const evidenceProjector: ControllerEvidenceReconciler = {
  reconcile: vi.fn(async (_controller, turn) => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: turn.evidenceEventSeq,
    throughSeq: turn.evidenceEventSeq,
    targetSeq: turn.evidenceEventSeq,
  })),
};

function safeQuestionPayload() {
  return {
    kind: "user_question",
    questions: [{
      id: "q1",
      prompt: "Which branch should I ship?",
      shortLabel: "Branch",
      multiSelect: false,
      allowFreeText: true,
      options: [{ value: "main", label: "Main", description: "The release branch." }],
    }],
  };
}

function questionPayloadWith(field: keyof typeof SECRETS) {
  const payload = safeQuestionPayload();
  const question = payload.questions[0]!;
  const option = question.options[0]!;
  if (field === "prompt") question.prompt = SECRETS.prompt;
  if (field === "shortLabel") question.shortLabel = SECRETS.shortLabel;
  if (field === "optionValue") option.value = SECRETS.optionValue;
  if (field === "optionLabel") option.label = SECRETS.optionLabel;
  if (field === "optionDescription") option.description = SECRETS.optionDescription;
  return payload;
}

it.each([
  ["a question prompt", "prompt"],
  ["a question short label", "shortLabel"],
  ["an option value", "optionValue"],
  ["an option label", "optionLabel"],
  ["an option description", "optionDescription"],
] as const)("downgrades a controller question carrying a credential in %s", (_scenario, field) => {
  const projected = parseControllerInteraction(INTERACTION_ID, questionPayloadWith(field));

  // Still identified, so the cursor can move past it; just not answerable.
  expect(projected).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });
  expect(JSON.stringify(projected)).not.toContain(SECRETS[field]);
});

it.each([
  ["a question prompt", "prompt"],
  ["an option label", "optionLabel"],
] as const)("keeps a worker-thread question carrying a credential in %s off Telegram", (_scenario, field) => {
  const projected = parseThreadInteraction(INTERACTION_ID, questionPayloadWith(field));

  expect(projected).toEqual({ kind: "unsupported", interactionId: INTERACTION_ID });
  expect(JSON.stringify(projected)).not.toContain(SECRETS[field]);
});

it.each([
  ["a bearer header", `curl -H "Authorization: Bearer ${SECRETS.approval}"`],
  ["CLI basic auth", "curl -u alice:hunter2 https://example.com/api"],
  ["a long-form credential flag", "deploy --token abcdefghijklmnop"],
  ["an inline assignment", "API_KEY=abcdef ./deploy.sh"],
  ["a percent-encoded secret", "curl https://example.com/?token=%41%42%43%44"],
  ["backticks", "echo `whoami`"],
  ["an empty command", ""],
  ["an over-long command", `echo ${"x".repeat(500)}`],
] as const)("makes an approval carrying %s unsupported, with no buttons", (_scenario, command) => {
  const projected = parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command },
    availableDecisions: ["allow_once", "deny"],
  });

  // An actionable button beside text the owner cannot read is a decision made
  // blind, so the whole interaction is downgraded rather than redacted.
  expect(projected).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "approval" },
  });
  const rendered = renderControllerInteraction(projected!);
  expect(rendered?.reply_markup).toBeUndefined();
  expect(JSON.stringify({ projected, rendered })).not.toContain(SECRETS.approval);
  expect(JSON.stringify({ projected, rendered })).not.toContain("hunter2");
  expect(JSON.stringify({ projected, rendered })).not.toContain("redacted");
});

it.each([
  ["a dotfile environment file", ".env"],
  ["an environment file variant", "env.production"],
  ["stored credentials", "credentials.json"],
  ["a private key", "id_rsa"],
  ["a PEM file", "server.pem"],
  ["an npm token file", ".npmrc"],
  ["an absolute path", "/etc/shadow"],
  ["a traversal", "../../etc/passwd"],
] as const)("makes an approval to write %s unsupported, with no buttons", (_scenario, writeScope) => {
  const projected = parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "file_change", writeScope },
    availableDecisions: ["allow_once", "deny"],
  });

  expect(projected).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "approval" },
  });
  expect(renderControllerInteraction(projected!)?.reply_markup).toBeUndefined();
});

it.each([
  ["a compact basic-auth flag", "curl -ualice:hunter2 https://example.com/api"],
  ["a compact password flag", "mysql -phunter2 -h db.internal"],
  ["a joined password flag", "mysql -p=hunter2 -h db.internal"],
  ["a compact long-form flag", "deploy --token=abcdefghijklmnop"],
  ["a percent-encoded compact flag", "curl -u%61lice:hunter2 https://example.com"],
  ["a doubly-encoded compact flag", "curl -u%2561lice:hunter2 https://example.com"],
  ["a token-shaped argument", "deploy sk-abcdefghijklmnop"],
  ["compact proxy auth", "curl -Uproxyuser:hunter2 https://example.com"],
  ["separated proxy auth", "curl -U proxyuser:hunter2 https://example.com"],
  ["a long-form proxy credential", "curl --proxy-user proxyuser:hunter2 https://example.com"],
  ["a joined long-form proxy credential", "curl --proxy-user=proxyuser:hunter2 https://example.com"],
  ["a database URI credential", "psql postgresql://alice:hunter2@db.internal/app"],
  ["an AMQP URI credential", "worker amqp://alice:hunter2@broker:5672"],
  ["an encoded database URI credential", "psql postgresql://alice:hunter2%40db.internal/app"],
  ["a doubly-encoded proxy credential", "curl -U%2570roxyuser:hunter2 https://example.com"],
  ["a single-quoted whole flag", "curl '-Uproxyuser:hunter2' https://example.com"],
  ["a double-quoted whole flag", "mysql \"-phunter2\" -h db.internal"],
  ["a quoted flag beside a quoted value", "curl '-u' 'alice:hunter2' https://example.com"],
  ["a quoted long-form proxy flag", "curl '--proxy-user' 'alice:hunter2' https://example.com"],
  ["adjacent quotes splitting a flag", "curl '-U''proxyuser:hunter2' https://example.com"],
  ["a backslash-escaped flag", "curl \\-Uproxyuser:hunter2 https://example.com"],
  ["a curly-quoted flag", "curl \u2018-Uproxyuser:hunter2\u2019 https://example.com"],
  ["a quoted encoded flag", "curl '-U%2570roxyuser:hunter2' https://example.com"],
  ["a quoted credential URI", "psql 'postgresql://alice:hunter2@db.internal/app'"],
  ["encoded single-quote delimiters", "curl %27-Uproxyuser:hunter2%27 https://example.com"],
  ["encoded double-quote delimiters", "curl %22-Uproxyuser:hunter2%22 https://example.com"],
  ["repeatedly encoded quote delimiters", "curl %2527-Uproxyuser:hunter2%2527 https://example.com"],
  ["an encoded quote around a long-form flag", "curl %27--proxy-user%27 alice:hunter2 https://example.com"],
] as const)("makes an approval carrying %s unsupported", (_scenario, command) => {
  const projected = parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command },
    availableDecisions: ["allow_once", "deny"],
  });

  expect(projected).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "approval" },
  });
  expect(renderControllerInteraction(projected!)?.reply_markup).toBeUndefined();
  expect(JSON.stringify(projected)).not.toContain("hunter2");
});

it.each([
  ["a token-shaped basename", "sk-abcdefghijklmnop"],
  ["a token-shaped basename in a directory", "config/rk-abcdefghijklmnop"],
] as const)("makes an approval to write %s unsupported", (_scenario, writeScope) => {
  // The command screen already knew this shape; the path screen must not have
  // its own, weaker idea of what a secret looks like.
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "file_change", writeScope },
    availableDecisions: ["allow_once", "deny"],
  })).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "approval" },
  });
});

it.each([
  ["a listing flag", "ls -la src"],
  ["an archive flag", "tar -xzf release.tar.gz"],
  ["a commit message flag", "git commit -m fix"],
  ["an ordinary script", "npm run build"],
  ["an unrelated long option", "curl --user-agent hanoon https://example.com"],
  ["another unrelated long option", "stream --passthrough --tokenizer word"],
  ["a bare short flag with no value", "mysql -p"],
  ["a short flag followed by another flag", "mysql -p -h db.internal"],
  ["a unique-sort flag", "sort -u names.txt"],
  ["an upgrade flag", "pip install -U requests"],
  ["a port mapping", "docker run -p 8080:8080 app"],
  ["a numeric user flag", "docker run -u 1000 app"],
  ["a credential-free URI", "curl https://example.com/api/v1"],
  ["a scp-style remote", "scp build.tar deploy@host:/srv"],
  // Prefix controls for the exact-name long form. They deliberately avoid the
  // words the pre-existing keyword screen already refuses on sight, so what they
  // test is the option-name rule and nothing else.
  ["a negated long option", "provision --no-user bob"],
  ["a prefixed long option", "provision --superuser-check on"],
  ["a suffixed long option", "curl --user-agent hanoon https://example.com"],
  ["a quoted ordinary flag", "sort '-u' names.txt"],
  ["a quoted commit message", "git commit -m 'fix the -p handling'"],
  ["a quoted path", "cat 'src/controller/service.ts'"],
  ["a quoted port mapping", "docker run '-p' '8080:8080' app"],
] as const)("still offers a decision on %s", (_scenario, command) => {
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command },
    availableDecisions: ["allow_once", "deny"],
  })).toMatchObject({ kind: "approval" });
});

it.each([
  ["an ordinary source file", "src/controller/service.ts"],
  ["a lockfile", "package-lock.json"],
  ["a name that merely starts with s", "skills/index.md"],
] as const)("still offers a decision on writing %s", (_scenario, writeScope) => {
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "file_change", writeScope },
    availableDecisions: ["allow_once", "deny"],
  })).toMatchObject({ kind: "approval" });
});

it("still offers exactly Allow once and Deny for a safe command and a safe path", () => {
  const command = parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command: "npm test" },
    availableDecisions: ["allow_once", "deny"],
  });
  expect(command).toMatchObject({ kind: "approval", summary: "wants to run:\n\n`npm test`" });
  expect(renderControllerInteraction(command!)?.reply_markup?.inline_keyboard.map((row) => row[0]?.text))
    .toEqual(["Allow once", "Deny"]);

  const path = parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "file_change", writeScope: "src/index.ts" },
    availableDecisions: ["allow_once", "deny"],
  });
  expect(path).toMatchObject({ kind: "approval", summary: "wants to write index.ts" });
  expect(renderControllerInteraction(path!)?.reply_markup?.inline_keyboard).toHaveLength(2);
});

it("refuses to persist a redacted placeholder as an approval summary", () => {
  // The projection no longer produces these, so the durable validator must no
  // longer accept them either.
  expect(isSafeControllerApprovalSummary("wants to run:\n\n`a redacted command`")).toBe(false);
  expect(isSafeControllerApprovalSummary("wants to write a protected path")).toBe(false);
  expect(isSafeControllerApprovalSummary("wants to run:\n\n`npm test`")).toBe(true);
});

it("still projects an ordinary safe question and approval in full", () => {
  expect(parseControllerInteraction(INTERACTION_ID, safeQuestionPayload())).toMatchObject({
    kind: "user_question",
    questions: [{ prompt: "Which branch should I ship?", shortLabel: "Branch" }],
  });
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command: "npm test" },
    availableDecisions: ["allow_once", "deny"],
  })).toMatchObject({ kind: "approval", summary: "wants to run:\n\n`npm test`" });
});

it("keeps a malformed identity invalid rather than downgrading it", () => {
  expect(parseControllerInteraction("", safeQuestionPayload())).toBeNull();
  expect(parseControllerInteraction(INTERACTION_ID, "not-an-object")).toBeNull();
});

/**
 * The whole durable path for one provider question: the real service records
 * whatever BB returns into a real file-backed SQLite database and enqueues the
 * real Telegram outbox row. Nothing here is stubbed at the storage layer, so a
 * leak would show up in the bytes on disk.
 */
it("keeps a provider credential out of storage, the outbox, and the logs", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-secret-${hostNumber++}` });
  const database = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.upsertProjectPolicy(policyFixture(), 1_500);
  store.createPairingCode(hashSecret("pair-secret"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-secret"), OWNER, OWNER, 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("executor lease was unavailable");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  const signal = AbortSignal.timeout(5_000);

  const leaked = questionPayloadWith("prompt");
  const question = leaked.questions[0]!;
  question.shortLabel = SECRETS.shortLabel;
  question.options[0]!.value = SECRETS.optionValue;
  question.options[0]!.label = SECRETS.optionLabel;
  question.options[0]!.description = SECRETS.optionDescription;

  harness.sdk.stub("threads.get", async () => ({
    id: THREAD_ID, projectId: "proj_secret", status: "active",
    providerId: "claude-code", archivedAt: null, deletedAt: null,
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 5 }));
  harness.sdk.stub("threads.events.list", async ({ afterSeq = "0" }: { afterSeq?: string }) => (
    Number(afterSeq) >= 5 ? [] : [{
      id: "e5", threadId: THREAD_ID, seq: 5, createdAt: 5, scope: { kind: "turn" },
      type: "system/userQuestion/lifecycle",
      data: { interactionId: INTERACTION_ID, providerId: "claude-code", status: "pending", resolution: null },
    }]
  ));
  harness.sdk.stub("threads.interactions.get", async () => ({
    id: INTERACTION_ID, threadId: THREAD_ID, status: "pending", payload: leaked,
  }));

  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY, telegramUserId: OWNER, telegramChatId: OWNER,
    updateId: 300, inputText: "ship it", now: 2_000,
  });
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence, turnId: turn.id, projectId: "proj_secret", hostId: "host_secret", threadId: THREAD_ID,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);

  const service = new LunaControllerService({
    store,
    adapter: new BbControllerAdapter({
      sdk: bb.sdk, pluginId: bb.pluginId,
      executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    }),
    evidenceProjector,
    interactionService: new ControllerInteractionService({
      store: new ControllerInteractionRepository(database),
      interactions: bb.sdk.threads.interactions,
      clock: () => 2_100,
    }),
    clock: { now: () => 2_100 },
  });

  // The reconciliation path takes no logger and calls no console, so the only
  // honest sink to watch is the process output anything there would have to use.
  // It is captured across the whole reconcile, and a canary proves the capture is
  // live — otherwise "no marker was logged" would also be true of an observer
  // that sees nothing at all, which is what the previous version of this
  // assertion amounted to.
  const logged: string[] = [];
  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originalConsole = consoleMethods.map((method) => [method, console[method]] as const);
  // `write` is inherited from the stream prototype, so assigning to it creates an
  // own property that assigning the original value back would leave behind.
  // Ownership is captured with the value and undone the same way it was made.
  const streams = [process.stdout, process.stderr].map((stream) => ({
    stream,
    write: stream.write,
    owned: Object.hasOwn(stream, "write"),
    descriptor: Object.getOwnPropertyDescriptor(stream, "write"),
  }));
  const canary = "controller-secret-log-canary";
  let reconciled: boolean;
  try {
    // Every mutation happens inside the try, so a failure part-way through
    // patching still reaches the restore below.
    for (const method of consoleMethods) {
      console[method] = ((...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); }) as typeof console.log;
    }
    for (const { stream } of streams) {
      stream.write = ((chunk: unknown) => { logged.push(String(chunk)); return true; }) as typeof stream.write;
    }
    reconciled = await service.reconcile({ ...fence, signal }, signal);
    console.log(canary);
  } finally {
    for (const [method, original] of originalConsole) console[method] = original;
    for (const { stream, owned, descriptor } of streams) {
      if (owned && descriptor) Object.defineProperty(stream, "write", descriptor);
      else delete (stream as { write?: unknown }).write;
    }
  }
  expect(reconciled).toBe(true);
  // Restored by identity *and* by ownership: this test must leave the global
  // streams and console exactly as it found them, down to whether `write` was
  // its own property or inherited.
  for (const { stream, write, owned, descriptor } of streams) {
    expect(stream.write).toBe(write);
    expect(Object.hasOwn(stream, "write")).toBe(owned);
    expect(Object.getOwnPropertyDescriptor(stream, "write")).toEqual(descriptor);
  }
  for (const [method, original] of originalConsole) expect(console[method]).toBe(original);
  // The observer is demonstrably live, so the absence checks below mean something.
  expect(logged.join("\n")).toContain(canary);

  const recorded = store.getPendingControllerInteraction(CONTROLLER_KEY);
  expect(recorded?.interaction).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });

  // Every durable and outbound surface, checked against the raw bytes.
  const payloadRows = database
    .prepare("SELECT payload_json FROM controller_interactions")
    .all() as { payload_json: string }[];
  expect(payloadRows).toHaveLength(1);
  const outbox = JSON.stringify(store.listOutbox(50));
  // Every row of every table, plus the file on disk: a leak into any column of
  // any table shows up here, which the schema DDL alone could never reveal.
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  expect(tables.length).toBeGreaterThan(5);
  const everyRow = tables
    .map((table) => JSON.stringify(database.prepare(`SELECT * FROM "${table.name}"`).all()))
    .join("\n");
  const rawDatabaseBytes = readFileSync(database.name);

  for (const marker of ALL_MARKERS) {
    expect(payloadRows[0]!.payload_json).not.toContain(marker);
    expect(outbox).not.toContain(marker);
    expect(everyRow).not.toContain(marker);
    expect(rawDatabaseBytes.includes(Buffer.from(marker, "utf8"))).toBe(false);
    expect(logged.join("\n")).not.toContain(marker);
  }
  // The owner is still told the thread is blocked, just not with the secret.
  expect(outbox).toContain("can't answer from here");
});

it.each([
  ["encoded single-quote delimiters", "Run curl %27-Uproxyuser:hunter2%27 now?"],
  ["encoded double-quote delimiters", "Run curl %22-Uproxyuser:hunter2%22 now?"],
  ["repeatedly encoded quote delimiters", "Run curl %2527-Uproxyuser:hunter2%2527 now?"],
  ["literal quotes", "Run curl '-Uproxyuser:hunter2' now?"],
] as const)("downgrades a question prompt carrying %s", (_scenario, prompt) => {
  // The question path has no second decoding step of its own, so this is the
  // central policy answering alone: decoding and dequoting must compose there.
  const projected = parseControllerInteraction(INTERACTION_ID, {
    kind: "user_question",
    questions: [{ id: "q1", prompt, multiSelect: false, allowFreeText: true, options: [] }],
  });

  expect(projected).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });
  expect(JSON.stringify(projected)).not.toContain("hunter2");
});

it.each([
  ["an ordinary encoded space", "Deploy the %20release%20 build?"],
  ["an encoded path", "Read %2Fsrc%2Fcontroller%2Fservice.ts?"],
  ["a quoted ordinary flag", "Should I run sort '-u' names.txt?"],
])("still projects a question prompt carrying %s", (_scenario, prompt) => {
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "user_question",
    questions: [{ id: "q1", prompt, multiSelect: false, allowFreeText: true, options: [] }],
  })).toMatchObject({ kind: "user_question" });
});

it.each([
  ["one layer below the decode cap", "Run curl %252527-Uproxyuser:hunter2%252527 now?"],
  ["exactly the decode cap", "Run curl %25252527-Uproxyuser:hunter2%25252527 now?"],
  ["one layer past the cap", "Run curl %2525252527-Uproxyuser:hunter2%2525252527 now?"],
] as const)("downgrades a question prompt encoded to %s", (_scenario, prompt) => {
  // Running out of decoding depth is not evidence of safety: what is left
  // unread could be anything, so exhaustion fails closed.
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "user_question",
    questions: [{ id: "q1", prompt, multiSelect: false, allowFreeText: true, options: [] }],
  })).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });
});

it.each([
  ["an ANSI-C quoted flag", "curl $'-Uproxyuser:hunter2' https://example.com"],
  ["an ANSI-C quoted password flag", "mysql $'-phunter2'"],
  ["ANSI-C quoting on both tokens", "curl $'--proxy-user' $'alice:hunter2' https://example.com"],
  ["a hex escape inside ANSI-C quoting", "curl $'\\x2d\\x55proxyuser:hunter2' https://example.com"],
  ["a localized double quote", "curl $\"-Uproxyuser:hunter2\" https://example.com"],
] as const)("makes an approval carrying %s unsupported", (_scenario, command) => {
  // Shell escape semantics are not reimplemented here; the construct itself is
  // treated as unreadable, which is the bounded and fail-closed reading.
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command },
    availableDecisions: ["allow_once", "deny"],
  })).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "approval" },
  });
});

it.each([
  ["an ordinary shell variable", "Deploy using $HOME/config?"],
  ["a braced shell variable", "Deploy using ${RELEASE} now?"],
  ["a quoted branch name", "Use the \"main\" branch?"],
  ["an encoded space", "Deploy the %20release%20 build?"],
  ["an encoded path", "Read %2Fsrc%2Fservice.ts?"],
] as const)("still projects a question prompt carrying %s", (_scenario, prompt) => {
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "user_question",
    questions: [{ id: "q1", prompt, multiSelect: false, allowFreeText: true, options: [] }],
  })).toMatchObject({ kind: "user_question" });
});

it.each([
  ["an encoded ANSI-C construct", "Run curl %24%27-Uproxyuser:hunter2%27 now?"],
  ["a repeatedly encoded ANSI-C construct", "Run curl %2524%2527-Uproxyuser:hunter2%2527 now?"],
  ["an encoded localized double quote", "Run curl %24%22-Uproxyuser:hunter2%22 now?"],
  ["a partially encoded construct", "Run curl $%27-Uproxyuser:hunter2%27 now?"],
] as const)("downgrades a question prompt carrying %s", (_scenario, prompt) => {
  // The construct is only visible while its quoting is intact, so each decoded
  // reading is checked before anything is dequoted.
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "user_question",
    questions: [{ id: "q1", prompt, multiSelect: false, allowFreeText: true, options: [] }],
  })).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });
});

it.each([
  ["an encoded ANSI-C construct", "curl %24%27-Uproxyuser:hunter2%27 https://example.com"],
  ["a repeatedly encoded ANSI-C construct", "curl %2524%2527-Uproxyuser:hunter2%2527 https://example.com"],
] as const)("makes an approval carrying %s unsupported", (_scenario, command) => {
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "approval",
    subject: { kind: "command", command },
    availableDecisions: ["allow_once", "deny"],
  })).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "approval" },
  });
});

it("treats a remaining escape at the decode cap as unread even beside a stray percent", () => {
  // A stray percent elsewhere must not vouch for the layer that went unread.
  // The pre-existing callback guard also refuses a bare percent, so this pins
  // the exhaustion signal rather than relying on that guard alone.
  const prompt = "Run curl %25252527-Uproxyuser:hunter2%25252527 at 50% load now?";
  expect(parseControllerInteraction(INTERACTION_ID, {
    kind: "user_question",
    questions: [{ id: "q1", prompt, multiSelect: false, allowFreeText: true, options: [] }],
  })).toEqual({
    kind: "unsupported", interactionId: INTERACTION_ID, metadata: { sourceKind: "user_question" },
  });
});
