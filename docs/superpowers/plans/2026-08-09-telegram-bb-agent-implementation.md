# Telegram BB Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native BB plugin that accepts one paired owner's Telegram task, runs implementation and independent review in visible BB threads, validates the exact GitHub PR head, and merges only after a fresh Telegram approval.

**Architecture:** A headless TypeScript plugin owns a durable SQLite state machine, a pure-I/O Telegram long-polling service, and one globally leased BB job executor/reconciler. Only that executor may touch BB threads, project attachments, environments, terminals, GitHub, or merge state. Pure domain code decides transitions and merge readiness; adapters isolate Telegram, BB SDK, terminal, GitHub, and SQLite behavior. BB 0.36.0 / plugin SDK 0.4.1 provide managed-worktree spawning, fresh provider conversations, project attachment uploads, environment reuse, authoritative thread/runtime status, environment status/PR inspection, terminal execution on the environment host, and `bb.sdk.environments.mergePullRequest`.

**Tech Stack:** TypeScript 5.7, Node 22 APIs, BB plugin SDK 0.4.1, BB app 0.36.0 build tooling, Zod 4, better-sqlite3, Vitest, Telegram Bot API, GitHub CLI.

## Global Constraints

- Package name is `bb-plugin-telegram-agent`; plugin id is `telegram-agent`; initial release has no `bb.app` frontend.
- Support BB `>=0.36` and plugin SDK `^0.4.1`; generate authoritative declarations with `bb plugin types .` before using SDK methods.
- Use Telegram long polling only; do not expose a webhook or bind BB to `0.0.0.0`.
- Support exactly one paired numeric Telegram user id in one private chat.
- Only explicitly enabled standard GitHub-backed BB projects appear in Telegram.
- Allow only one active Telegram-controlled job globally.
- Create visible implementation threads in managed BB worktrees and visible review child threads with `environment: { type: "reuse", environmentId }`.
- Spawn every review with `threads.spawn`, never `threads.fork`; parenting is for visibility and coordination, not provider-context inheritance.
- Keep the Telegram polling service and BB event callbacks as pure ingress/nudges. Only the single generation-fenced executor may upload handoffs, spawn/steer/stop threads, inspect environments, run terminals, query GitHub, or merge.
- Upload immutable work-order/review-packet attachments outside the repository and use tiny thread instructions; never place orchestration artifacts in the managed worktree or stuff a complete diff into prompt text.
- Never interpret Telegram text as a shell command, project id, validation command, or merge instruction.
- Never use server-local `node:fs` for a project/environment path; route remote work through BB SDK environment, terminal, or file APIs.
- Reviewer prose never authorizes merge; require strict JSON plus deterministic environment, command, GitHub, and exact-SHA gates.
- Resolve the remote PR head only with `git ls-remote --exit-code origin refs/pull/<number>/head` on the environment host. Treat `gh`, BB PR metadata, and provider output as non-authoritative for the head OID.
- Mirror worker liveness from exactly one BB-owned source (`threads.get`/thread lifecycle state, or terminal state). Stale/unknown liveness alerts and blocks; it never speculatively starts a replacement worker.
- Require a hashed, one-use, fifteen-minute Telegram approval nonce and re-evaluate every merge gate at click time.
- Default to three review cycles; Continue grants one further group of three only when no other job is active.
- Cancellation never archives threads or deletes a worktree, branch, or PR.
- Bot tokens remain BB secret settings and never enter SQLite, logs, prompts, tests, or command output.
- Initial migrations are append-only; never edit or reorder a shipped `bb.storage.migrate` statement.
- Every behavior change follows RED, GREEN, focused regression, then commit.

---

## Planned File Structure

| File | Responsibility |
|---|---|
| `package.json` | Package identity, BB manifest, scripts, and pinned development dependencies. |
| `.gitignore` | Exclude dependencies, build artifacts, coverage, and local environment files. |
| `tsconfig.json` | Strict backend/test compilation and generated SDK type mapping. |
| `server.ts` | Minimal BB factory entrypoint. |
| `src/plugin.ts` | Settings, storage, services, events, CLI, and disposal wiring. |
| `src/config.ts` | Parse global settings and project execution policy. |
| `src/crypto.ts` | Random ids/nonces and SHA-256 hashing. |
| `src/async.ts` | Abortable sleeps used by polling, retries, and terminal waits. |
| `src/errors.ts` | Needs-configuration construction and bounded secret-safe error text. |
| `src/domain/models.ts` | Job, attempt, policy, effect, outbox, approval, validation, and review types/schemas. |
| `src/domain/state-machine.ts` | Pure legal transitions and emitted effects. |
| `src/domain/review.ts` | Strict reviewer JSON parsing and assessment. |
| `src/domain/gates.ts` | Pure merge-gate evaluation and ready receipt. |
| `src/storage/migrations.ts` | Append-only SQLite migration strings. |
| `src/storage/store.ts` | Transactional durable repository and effect/outbox leases. |
| `src/telegram/types.ts` | Narrow Telegram update/message/callback schemas. |
| `src/telegram/client.ts` | Bot API requests, long polling, retries, timeouts, and redacted errors. |
| `src/telegram/view.ts` | Deterministic messages, keyboards, callback payloads, and bounded evidence. |
| `src/telegram/ingress.ts` | Authorization, pairing, project selection, confirmation, steering, and callbacks. |
| `src/bb/handoffs.ts` | Immutable implementation work orders and review packets uploaded as BB project attachments. |
| `src/bb/prompts.ts` | Tiny attachment instructions plus remediation and format-correction prompts. |
| `src/bb/runner.ts` | BB thread/environment/PR adapter. |
| `src/bb/terminal-command.ts` | Bounded commands on the environment host. |
| `src/bb/validation.ts` | Project validation, Git-native remote-head truth, and `gh` PR/check metadata. |
| `src/services/review-handler.ts` | Review-output parsing, mutation checks, and remediation decisions. |
| `src/services/approval-service.ts` | One-use approval issuance, hashing, expiry, and consumption. |
| `src/services/merge-handler.ts` | Fresh gate collection, BB PR merge, and post-merge confirmation. |
| `src/services/effect-runner.ts` | Generation-fenced, idempotent execution of every BB/GitHub/worktree effect. |
| `src/services/telegram-service.ts` | Abortable long-poll loop and update offset ownership. |
| `src/services/worker-liveness.ts` | Single-source BB thread/terminal liveness projection and stale alerting. |
| `src/services/job-executor-service.ts` | Singleton executor lease, startup/periodic reconciliation, effects, and outbox. |
| `src/cli.ts` | `bb telegram-agent` parser and operator commands. |
| `tests/helpers.ts` | Deterministic clocks, ids, Telegram fetch mock, and BB fixtures. |
| `tests/*.test.ts` | Focused domain, adapter, service, CLI, and end-to-end tests. |
| `README.md` | Safe setup, pairing, project policy, operation, and recovery guide. |
| `docs/acceptance-test.md` | Disposable-repository live acceptance procedure and evidence template. |

---

### Task 1: Loadable Plugin Foundation and Authoritative SDK Types

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `.gitignore`
- Create: `tsconfig.json`
- Create: `server.ts`
- Create: `src/config.ts`
- Create: `src/plugin.ts`
- Create: `tests/plugin.test.ts`
- Generate: `types/bb-plugin-sdk.d.ts`

**Interfaces:**
- Produces: `GlobalConfig`, `parseGlobalConfig(values)`, and `createPlugin(bb: BbPluginApi): Promise<void>`.
- Consumes: no application code; only generated BB declarations.

- [ ] **Step 1: Write the package manifest before installing dependencies**

```json
{
  "name": "bb-plugin-telegram-agent",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": {
    "bb": ">=0.36",
    "bbPluginSdk": "^0.4.1"
  },
  "bb": {
    "name": "Telegram Agent",
    "description": "Control reviewed BB implementation jobs from a paired Telegram chat.",
    "branding": { "icon": "Bot" },
    "server": "./server.ts",
    "skills": []
  },
  "scripts": {
    "build": "bb plugin build",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm test && npm run build"
  },
  "devDependencies": {
    "@bb/plugin-sdk": "0.4.1",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "bb-app": "0.36.0",
    "better-sqlite3": "^12.0.0",
    "hono": "^4.11.9",
    "typescript": "^5.7.0",
    "vitest": "^3.2.0",
    "zod": "^4.3.6"
  }
}
```

- [ ] **Step 2: Install the declared dependencies and generate the SDK contract**

Create `.gitignore` first:

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
```

Run:

```bash
npm install
bb plugin types .
```

Expected: `package-lock.json` and `types/bb-plugin-sdk.d.ts` exist; generated declarations include `mergePullRequest`, terminal environment scope, project attachment upload, thread spawn with `input`, thread runtime state, and six plugin thread events.

- [ ] **Step 3: Add strict TypeScript configuration**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["node", "vitest/globals"],
    "paths": {
      "@bb/plugin-sdk": ["./types/bb-plugin-sdk.d.ts"]
    },
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": ["server.ts", "src/**/*.ts", "tests/**/*.ts", "types/**/*.d.ts"]
}
```

- [ ] **Step 4: Write the failing load/configuration test**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "../server";

it("loads safely and requests the secret bot token", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "telegram-agent" });

  await plugin(bb);

  expect(harness.needsConfigurationMessages).toEqual([
    "Set the Telegram bot token in Extensions → Plugins → Telegram Agent.",
  ]);
});
```

- [ ] **Step 5: Run the focused test to verify RED**

Run: `npm test -- tests/plugin.test.ts`

Expected: FAIL because `server.ts` and `createPlugin` do not exist.

- [ ] **Step 6: Implement load-safe settings and entrypoints**

```ts
// src/config.ts
import { z } from "zod";

const globalConfigSchema = z.object({
  botToken: z.string().min(1),
  bbAppBaseUrl: z.union([z.literal(""), z.string().url()]),
  pollTimeoutSeconds: z.coerce.number().int().min(5).max(50),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type GlobalConfigResult =
  | { ok: true; value: GlobalConfig }
  | { ok: false; message: string };

export function parseGlobalConfig(values: {
  botToken?: string;
  bbAppBaseUrl: string;
  pollTimeoutSeconds: string;
}): GlobalConfigResult {
  if (!values.botToken) {
    return { ok: false, message: "Set the Telegram bot token in Extensions → Plugins → Telegram Agent." };
  }
  const parsed = globalConfigSchema.safeParse(values);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: "Fix the Telegram Agent URL or polling timeout setting." };
}
```

```ts
// src/plugin.ts
import type { BbPluginApi } from "@bb/plugin-sdk";
import { parseGlobalConfig } from "./config";

export async function createPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    botToken: { type: "string", label: "Telegram bot token", secret: true },
    bbAppBaseUrl: { type: "string", label: "BB app base URL", default: "" },
    pollTimeoutSeconds: {
      type: "string",
      label: "Telegram poll timeout in seconds",
      default: "30",
    },
  });
  const config = parseGlobalConfig(await settings.get());
  if (!config.ok) bb.status.needsConfiguration(config.message);
}
```

```ts
// server.ts
import type { BbPluginApi } from "@bb/plugin-sdk";
import { createPlugin } from "./src/plugin";

export default function plugin(bb: BbPluginApi): Promise<void> {
  return createPlugin(bb);
}
```

- [ ] **Step 7: Run focused tests, typecheck, and build to verify GREEN**

Run:

```bash
npm test -- tests/plugin.test.ts
npm run typecheck
npm run build
```

Expected: focused test passes; typecheck exits 0; `dist/server.js` and `dist/server.meta.json` are generated for plugin id `telegram-agent`.

- [ ] **Step 8: Commit the loadable foundation**

```bash
git add .gitignore package.json package-lock.json tsconfig.json server.ts src/config.ts src/plugin.ts tests/plugin.test.ts types
git commit -m "chore: scaffold Telegram agent plugin"
```

---

### Task 2: Pairing, Project Policy, and Durable SQLite Foundation

**Files:**
- Create: `src/crypto.ts`
- Create: `src/domain/models.ts`
- Create: `src/storage/migrations.ts`
- Create: `src/storage/store.ts`
- Create: `tests/storage.test.ts`
- Modify: `src/plugin.ts`

**Interfaces:**
- Produces: `TelegramAgentStore`, `ProjectPolicy`, `ExecutionProfile`, `createSecret()`, `hashSecret()`, `openStore(bb.storage)`.
- Consumes: `BbPluginApi["storage"]` only; no Telegram or BB thread adapter.

- [ ] **Step 1: Write failing pairing and project-policy persistence tests**

```ts
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";

it("pairs with a code exactly once without storing plaintext", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("pair-me"), 1_000, 11_000);

  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "70", 2_000)).toEqual({ ok: true });
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "8", "80", 2_001)).toEqual({ ok: false, reason: "consumed" });
  const row = db.prepare("SELECT code_hash FROM pairing_codes").get();
  expect(row).toEqual({ code_hash: hashSecret("pair-me") });
  expect(JSON.stringify(row)).not.toContain("pair-me");
});

it("round-trips a validated enabled project policy", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const store = openStore(bb.storage);
  store.upsertProjectPolicy({
    projectId: "proj_1",
    alias: "cyndra",
    enabled: true,
    githubRepository: "acme/cyndra",
    baseBranch: "main",
    implementation: {},
    review: {},
    validationCommands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }],
    requiredChecks: ["test"],
    outputRedactionPatterns: [],
    workerLivenessWatchdogMs: 300_000,
    maxReviewCycles: 3,
    mergeMethod: "squash",
  }, 1_000);

  expect(store.listEnabledProjectPolicies()).toHaveLength(1);
  expect(store.getProjectPolicy("proj_1")?.policy.alias).toBe("cyndra");
});
```

Add a storage test proving `bindTelegramIdentity` preserves owner/cursor for the same numeric bot id, refuses a different bot while a job is active, and transactionally resets Telegram cursor/owner/approvals when a different bot is bound with no active job.

- [ ] **Step 2: Run storage tests to verify RED**

Run: `npm test -- tests/storage.test.ts`

Expected: FAIL because `openStore`, policy schemas, and cryptographic helpers do not exist.

- [ ] **Step 3: Define ids, execution profiles, and project policy schema**

```ts
// src/domain/models.ts
import { z } from "zod";

export const executionProfileSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]).optional(),
  serviceTier: z.enum(["default", "fast"]).optional(),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
}).strict();

export const projectPolicySchema = z.object({
  projectId: z.string().startsWith("proj_"),
  alias: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/),
  enabled: z.boolean(),
  githubRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  baseBranch: z.string().min(1),
  implementation: executionProfileSchema,
  review: executionProfileSchema,
  validationCommands: z.array(z.object({
    name: z.string().min(1).max(40),
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
  }).strict()).max(20),
  requiredChecks: z.array(z.string().min(1)).max(50),
  outputRedactionPatterns: z.array(z.string().min(1).max(200)).max(20),
  workerLivenessWatchdogMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
  maxReviewCycles: z.number().int().min(1).max(10).default(3),
  mergeMethod: z.enum(["merge", "rebase", "squash"]),
}).strict().superRefine((policy, context) => {
  for (const [index, pattern] of policy.outputRedactionPatterns.entries()) {
    try {
      new RegExp(pattern, "g");
    } catch {
      context.addIssue({ code: "custom", path: ["outputRedactionPatterns", index], message: "Invalid regular expression" });
    }
  }
});

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;
```

- [ ] **Step 4: Add cryptographic helpers with injectable randomness**

```ts
// src/crypto.ts
import { createHash, randomBytes } from "node:crypto";

export function createSecret(bytes = 24, random = randomBytes): string {
  return random(bytes).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
```

- [ ] **Step 5: Add the append-only initial migration**

`INITIAL_MIGRATIONS` must contain these tables and constraints in one immutable first statement:

```ts
// src/storage/migrations.ts
export const INITIAL_MIGRATIONS = [String.raw`
CREATE TABLE owners (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  telegram_user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE telegram_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  bot_id TEXT NOT NULL,
  username TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TABLE project_policies (
  project_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  policy_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_update_id INTEGER NOT NULL UNIQUE,
  request_text TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  project_id TEXT,
  policy_version INTEGER,
  policy_json TEXT,
  environment_id TEXT,
  implementation_thread_id TEXT,
  review_thread_id TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_head_sha TEXT,
  status_message_id INTEGER,
  review_cycle INTEGER NOT NULL DEFAULT 0,
  review_block_at INTEGER NOT NULL DEFAULT 3,
  cancel_requested_at INTEGER,
  blocked_reason TEXT,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_job
  ON jobs ((1))
  WHERE state NOT IN ('merged', 'cancelled', 'blocked');
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('implementation', 'review', 'validation')),
  ordinal INTEGER NOT NULL,
  thread_id TEXT,
  head_sha TEXT,
  handoff_path TEXT,
  handoff_sha256 TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(job_id, kind, ordinal)
);
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at INTEGER
);
CREATE TABLE telegram_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_offset INTEGER NOT NULL
);
INSERT INTO telegram_cursor(singleton, next_offset) VALUES (1, 0);
CREATE TABLE callbacks (
  callback_query_id TEXT PRIMARY KEY,
  job_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
CREATE TABLE approvals (
  nonce_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  head_sha TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  outcome TEXT
);
CREATE TABLE effects (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'done', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_generation INTEGER,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE executor_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  heartbeat_at INTEGER,
  lease_expires_at INTEGER
);
INSERT INTO executor_lease(singleton, generation) VALUES (1, 0);
CREATE TABLE worker_liveness (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('implementation', 'review', 'validation', 'merge')),
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('bb_thread', 'bb_terminal')),
  resource_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'active', 'stopping', 'idle', 'failed', 'unknown', 'stale')),
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  stale_notified_at INTEGER
);
CREATE TABLE outbox (
  logical_key TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id INTEGER,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'sent', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_generation INTEGER,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`] as const;
```

- [ ] **Step 6: Implement `openStore` and the pairing/policy transactions**

`TelegramAgentStore` must expose these exact initial methods:

```ts
export interface TelegramAgentStore {
  createPairingCode(codeHash: string, createdAt: number, expiresAt: number): void;
  pairOwnerWithCode(codeHash: string, userId: string, chatId: string, now: number): { ok: true } | { ok: false; reason: "missing" | "expired" | "consumed" | "already_paired" };
  getOwner(): { userId: string; chatId: string; pairedAt: number } | null;
  revokeOwner(now: number): boolean;
  bindTelegramIdentity(input: { botId: string; username: string; now: number; hasActiveJob: boolean }): "created" | "same" | "changed" | "active_job_conflict";
  getTelegramIdentity(): { botId: string; username: string; verifiedAt: number } | null;
  upsertProjectPolicy(policy: ProjectPolicy, now: number): { policy: ProjectPolicy; version: number };
  getProjectPolicy(projectId: string): { policy: ProjectPolicy; version: number } | null;
  getProjectPolicyByAlias(alias: string): { policy: ProjectPolicy; version: number } | null;
  listEnabledProjectPolicies(): Array<{ policy: ProjectPolicy; version: number }>;
}
```

Use prepared statements, `projectPolicySchema.parse(JSON.parse(policy_json))` on reads, and one SQLite transaction for code consumption plus owner pairing. `pairOwnerWithCode` must guard the unconsumed, unexpired code and singleton owner insert in that transaction so a crash cannot consume a code without pairing its owner. Every policy upsert increments `version` and returns the stored record; jobs retain the selected version even if operator policy changes later.

- [ ] **Step 7: Wire storage creation into the plugin factory**

```ts
const store = openStore(bb.storage);
void store;
```

The factory must open storage before marking configuration state so settings recovery and local CLI commands can still inspect pairing/project state.

- [ ] **Step 8: Run storage and foundation verification**

Run:

```bash
npm test -- tests/storage.test.ts tests/plugin.test.ts
npm run typecheck
```

Expected: both test files pass; plaintext pairing code does not appear in persisted rows; invalid policy JSON fails closed.

- [ ] **Step 9: Commit durable configuration storage**

```bash
git add src/crypto.ts src/domain/models.ts src/storage src/plugin.ts tests/storage.test.ts
git commit -m "feat: add pairing and project policy storage"
```

---

### Task 3: Pure Job State Machine and Transactional Effects

**Files:**
- Modify: `src/domain/models.ts`
- Create: `src/domain/state-machine.ts`
- Modify: `src/storage/store.ts`
- Create: `tests/helpers.ts`
- Create: `tests/state-machine.test.ts`
- Create: `tests/job-store.test.ts`

**Interfaces:**
- Produces: `Job`, `JobState`, `JobEvent`, `JobEffect`, `transition(job, event, now)`, and transactional job/effect methods on `TelegramAgentStore`.
- Consumes: `ProjectPolicy` from Task 2.

- [ ] **Step 1: Write a failing legal-transition table test**

```ts
import { transition } from "../src/domain/state-machine";
import { jobFixture, policyFixture } from "./helpers";

it.each([
  ["awaiting_project", { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, "awaiting_confirmation", "render_status"],
  ["awaiting_confirmation", { type: "CONFIRMED" }, "creating_implementation", "spawn_implementation"],
  ["creating_implementation", { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, "implementing", "render_status"],
  ["implementing", { type: "IMPLEMENTATION_IDLE" }, "locating_pr", "inspect_implementation"],
  ["locating_pr", { type: "PR_LOCATED", number: 7, url: "https://github.test/pr/7" }, "resolving_pr_head", "resolve_pr_head"],
  ["resolving_pr_head", { type: "PR_HEAD_RESOLVED", headSha: "a".repeat(40) }, "reviewing", "spawn_review"],
  ["reviewing", { type: "REVIEW_PASSED", headSha: "a".repeat(40) }, "validating", "run_validation"],
  ["validating", { type: "VALIDATION_PASSED", headSha: "a".repeat(40) }, "awaiting_merge_approval", "issue_approval"],
  ["awaiting_merge_approval", { type: "APPROVAL_ACCEPTED", headSha: "a".repeat(40) }, "merging", "merge_pr"],
  ["merging", { type: "MERGE_SUCCEEDED", message: "merged" }, "merged", "render_status"],
] as const)("moves %s to %s", (from, event, to, effect) => {
  const result = transition(jobFixture({ state: from }), event as never, 10_000);
  expect(result.job.state).toBe(to);
  expect(result.effects.map((item) => item.kind)).toContain(effect);
});
```

- [ ] **Step 2: Add failing tests for cancellation, retries, review limits, and illegal events**

Cover these exact rules:

- `CANCEL_REQUESTED` sets `cancelRequestedAt`, emits `revoke_approvals`, and emits `stop_thread` only when a worker thread is active.
- While `cancelRequestedAt` is set, non-cancellation events emit no external effects.
- `CANCEL_CONFIRMED` transitions to `cancelled`.
- `REVIEW_CHANGES_REQUESTED` increments `reviewCycle`; cycles 1-2 emit `send_remediation`; cycle 3 transitions to `blocked`.
- Every implementation/remediation completion entering `locating_pr` clears `prHeadSha`, revokes approvals, and makes prior review/validation receipts ineligible; only a new `PR_HEAD_RESOLVED` can repopulate the head.
- `CONTINUE_REVIEW` is legal in the pure machine only from `blocked` with `blockedReason === "review_limit"`; it clears the reason and resets the next blocking threshold to current cycle plus three. The ingress/CLI caller must prove `getActiveJob()` is null before applying it.
- `FAILED` records `resumeState`; `RETRY` restores it and emits the stage's single deterministic effect.
- An event invalid for the current state throws `IllegalTransitionError` without mutating the input object.

- [ ] **Step 3: Run state-machine tests to verify RED**

Run: `npm test -- tests/state-machine.test.ts`

Expected: FAIL because the job/event/effect unions and transition function do not exist.

- [ ] **Step 4: Define exhaustive job, event, and effect types**

```ts
export type JobState =
  | "awaiting_project"
  | "awaiting_confirmation"
  | "creating_implementation"
  | "implementing"
  | "locating_pr"
  | "resolving_pr_head"
  | "reviewing"
  | "remediating"
  | "validating"
  | "awaiting_merge_approval"
  | "merging"
  | "failed"
  | "blocked"
  | "cancelled"
  | "merged";

export interface Job {
  id: string;
  sourceUpdateId: number;
  requestText: string;
  state: JobState;
  resumeState: JobState | null;
  projectId: string | null;
  policyVersion: number | null;
  policy: ProjectPolicy | null;
  environmentId: string | null;
  implementationThreadId: string | null;
  reviewThreadId: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prHeadSha: string | null;
  statusMessageId: number | null;
  reviewCycle: number;
  reviewBlockAt: number;
  cancelRequestedAt: number | null;
  blockedReason: "review_limit" | "configuration" | "cancellation_unconfirmed" | "permanent_effect_failure" | null;
  lastError: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerLiveness {
  jobId: string;
  workerKind: "implementation" | "review" | "validation" | "merge";
  resourceKind: "bb_thread" | "bb_terminal";
  resourceId: string;
  generation: number;
  state: "starting" | "active" | "stopping" | "idle" | "failed" | "unknown" | "stale";
  sourceUpdatedAt: number;
  observedAt: number;
  staleNotifiedAt: number | null;
}

export interface JobEffect {
  idempotencyKey: string;
  jobId: string;
  kind:
    | "render_status"
    | "spawn_implementation"
    | "inspect_implementation"
    | "resolve_pr_head"
    | "spawn_review"
    | "send_remediation"
    | "run_validation"
    | "issue_approval"
    | "revoke_approvals"
    | "merge_pr"
    | "stop_thread"
    | "steer_implementation"
    | "reconcile_job";
  payload: Record<string, unknown>;
}
```

Define `JobEvent` as a discriminated union containing every event named in the tests plus `REVIEW_STARTED`, `REVIEW_BLOCKED`, `PR_MISSING`, `PR_UNAVAILABLE`, `REMEDIATION_SENT`, `VALIDATION_FAILED`, `APPROVAL_STALE`, `MERGE_FAILED`, and `THREAD_FAILED`. `PR_LOCATED` may carry only PR identity; only `PR_HEAD_RESOLVED`, emitted by Task 8's Git-native resolver, may set `job.prHeadSha` and unlock `spawn_review`. Every event carries only validated ids, SHAs, bounded summaries, or typed reasons. `createJob` directly establishes `awaiting_project`; there is no pre-persisted draft state.

- [ ] **Step 5: Implement the immutable transition function**

```ts
export function transition(job: Job, event: JobEvent, now: number): TransitionResult {
  const next = structuredClone(job);
  const effects: JobEffect[] = [];
  const emit = (kind: JobEffect["kind"], payload: Record<string, unknown> = {}) => {
    effects.push({
      idempotencyKey: `${job.id}:${job.version + 1}:${kind}`,
      jobId: job.id,
      kind,
      payload,
    });
  };

  if (event.type === "CANCEL_REQUESTED") {
    next.cancelRequestedAt = now;
    emit("revoke_approvals");
    if (next.implementationThreadId || next.reviewThreadId) emit("stop_thread");
  } else if (event.type === "CANCEL_CONFIRMED") {
    next.state = "cancelled";
    emit("render_status");
  } else if (next.cancelRequestedAt !== null) {
    return { job: next, effects: [] };
  } else {
    applyStateSpecificTransition(next, event, emit);
  }

  next.version += 1;
  next.updatedAt = now;
  return { job: next, effects };
}
```

`applyStateSpecificTransition` must implement the complete transition table tested in Steps 1-2. It must compare review/validation/approval SHAs to `job.prHeadSha`; any mismatch revokes approval, clears the recorded head, transitions to `resolving_pr_head`, and emits `resolve_pr_head`. Only a subsequent Git-native `PR_HEAD_RESOLVED` may store the new SHA and emit a fresh `spawn_review` effect.

- [ ] **Step 6: Add transactional job and effect methods to the store**

```ts
createJob(input: { id: string; sourceUpdateId: number; requestText: string; now: number }): Job;
getJob(jobId: string): Job | null;
getActiveJob(): Job | null;
findJobByThreadId(threadId: string): Job | null;
listJobs(limit: number): Job[];
applyJobEvent(jobId: string, expectedVersion: number, event: JobEvent, now: number): Job;
listEffectsForJob(jobId: string): StoredEffect[];
beginTelegramUpdate(updateId: number, now: number): "process" | "processed";
completeTelegramUpdate(updateId: number, outcome: string, now: number): void;
failTelegramUpdate(updateId: number, error: string, now: number): void;
getNextTelegramOffset(): number;
recordCallback(callbackId: string, jobId: string | null, action: string, outcome: string, now: number): boolean;
enqueueReconcileForThread(threadId: string, now: number): boolean;
```

`applyJobEvent` must use a SQLite transaction: read the expected version, call `transition`, update the row with `WHERE version = ?`, insert each effect with `INSERT OR IGNORE`, and throw `VersionConflictError` if the guarded update changes zero rows.

`createJob` uses `INSERT OR IGNORE` on the deterministic id/source update. On replay it returns the existing row only when `sourceUpdateId` and `requestText` match; any mismatch throws `IdempotencyConflictError`. `PROJECT_SELECTED` copies both the validated policy JSON and its version into the job so later operator edits cannot change an active/recovered job. Continuing a blocked job must first confirm `getActiveJob()` is null.

- [ ] **Step 7: Run state and persistence tests to verify GREEN**

Run:

```bash
npm test -- tests/state-machine.test.ts tests/job-store.test.ts
npm run typecheck
```

Expected: legal transition table passes; illegal transitions leave input unchanged; duplicate effect insertion produces one row; two concurrent expected versions yield one success and one `VersionConflictError`.

- [ ] **Step 8: Commit the durable state machine**

```bash
git add src/domain/models.ts src/domain/state-machine.ts src/storage/store.ts tests/state-machine.test.ts tests/job-store.test.ts tests/helpers.ts
git commit -m "feat: add durable job state machine"
```

---

### Task 4: Telegram Bot API Client and Deterministic Views

**Files:**
- Create: `src/telegram/types.ts`
- Create: `src/telegram/client.ts`
- Create: `src/telegram/view.ts`
- Create: `src/async.ts`
- Create: `tests/telegram-client.test.ts`
- Create: `tests/telegram-view.test.ts`
- Modify: `tests/helpers.ts`

**Interfaces:**
- Produces: `TelegramClient`, `TelegramUpdate`, `TelegramMessage`, `TelegramCallbackQuery`, `renderJobStatus`, `renderProjectPicker`, `parseCallbackData`.
- Consumes: `Job` and `ProjectPolicy` from domain models.

- [ ] **Step 1: Write failing transport tests with a token-redacting fetch mock**

```ts
it("long-polls with an offset and returns validated updates", async () => {
  const fetchMock = telegramFetch([
    { ok: true, result: [{ update_id: 42, message: privateMessage("fix it") }] },
  ]);
  const client = new TelegramClient("123:secret", fetchMock);

  const updates = await client.getUpdates(42, 30, AbortSignal.timeout(1_000));

  expect(updates[0]?.update_id).toBe(42);
  expect(fetchMock.calls[0]?.body).toContain('"offset":42');
  expect(JSON.stringify(fetchMock.calls)).not.toContain("123:secret");
});

it("honors retry_after and aborts the delay", async () => {
  const fetchMock = telegramFetch([
    { ok: false, error_code: 429, description: "slow", parameters: { retry_after: 1 } },
    { ok: true, result: { message_id: 9 } },
  ]);
  const client = new TelegramClient("token", fetchMock, { sleep: immediateSleep });
  await expect(client.sendMessage("1", { text: "hello" })).resolves.toMatchObject({ message_id: 9 });
  expect(immediateSleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
});
```

`telegramFetch` must record only the Bot API method name and parsed request body, never the full token-bearing URL. Add a separate error assertion that a simulated 401 throws a message containing `Telegram API 401` but not `123:secret` or the raw response body.

- [ ] **Step 2: Write failing view/callback tests**

Assert that project callbacks remain below Telegram's 64-byte limit, merge callbacks contain only the nonce, all job text is HTML escaped, evidence is bounded to 3,500 characters, and the Ready card contains project, PR, changed-file/diff-stat summary, SHA, implementation/review thread ids, the configured general BB app link, review, validation, checks, and expiry. Do not invent an unverified thread deep-link route.

- [ ] **Step 3: Run focused Telegram tests to verify RED**

Run: `npm test -- tests/telegram-client.test.ts tests/telegram-view.test.ts`

Expected: FAIL because Telegram schemas, client, renderer, and callback parser do not exist.

- [ ] **Step 4: Define the narrow Telegram schemas**

```ts
export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    message_id: z.number().int(),
    from: z.object({ id: z.number().int(), is_bot: z.boolean() }).passthrough(),
    chat: z.object({ id: z.number().int(), type: z.enum(["private", "group", "supergroup", "channel"]) }).passthrough(),
    text: z.string().optional(),
    reply_to_message: z.object({ message_id: z.number().int() }).passthrough().optional(),
  }).passthrough().optional(),
  callback_query: z.object({
    id: z.string(),
    from: z.object({ id: z.number().int(), is_bot: z.boolean() }).passthrough(),
    message: z.object({ message_id: z.number().int(), chat: z.object({ id: z.number().int(), type: z.string() }).passthrough() }).passthrough().optional(),
    data: z.string().max(64).optional(),
  }).passthrough().optional(),
}).passthrough();
```

- [ ] **Step 5: Implement the redacted Bot API client**

First add the shared abortable delay:

```ts
// src/async.ts
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
```

```ts
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly deps = { sleep: abortableSleep },
  ) {}

  getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, payload: SendMessagePayload, signal?: AbortSignal): Promise<{ message_id: number }>;
  editMessage(chatId: string, messageId: number, payload: SendMessagePayload, signal?: AbortSignal): Promise<void>;
  answerCallback(callbackQueryId: string, text: string, signal?: AbortSignal): Promise<void>;
  getMe(signal?: AbortSignal): Promise<{ id: number; username: string }>;
}
```

All calls use POST JSON to `https://api.telegram.org/bot${token}/${method}`. `getUpdates` always sends `allowed_updates: ["message", "callback_query"]`. Combine the caller signal with a request timeout using `AbortSignal.any`: 15 seconds for ordinary methods and `(timeoutSeconds + 5) * 1_000` for long polling. Parse `{ ok, result, error_code, description, parameters.retry_after }`; retry 429 and transient 5xx at most three times; cap exponential backoff at 30 seconds; return a typed non-retryable `TelegramConflictError` for 409 polling conflicts; treat Telegram's exact 400 `message is not modified` edit response as an idempotent success; never include the request URL, token, raw response body, or user message text in thrown errors.

- [ ] **Step 6: Implement deterministic HTML views and callback grammar**

Use these exact callback forms:

```ts
type CallbackAction =
  | { type: "project"; jobId: string; alias: string }
  | { type: "start"; jobId: string }
  | { type: "cancel"; jobId: string }
  | { type: "retry"; jobId: string }
  | { type: "review"; jobId: string }
  | { type: "merge"; nonce: string };
```

Encode them as `p:<job>:<alias>`, `s:<job>`, `c:<job>`, `r:<job>`, `v:<job>`, and `m:<nonce>`. `jobId` is a 22-character base64url id; alias is at most 24 characters; nonce is a 32-character base64url string. Reject any callback that fails the anchored grammar or length limit.

- [ ] **Step 7: Run Telegram tests to verify GREEN**

Run:

```bash
npm test -- tests/telegram-client.test.ts tests/telegram-view.test.ts
npm run typecheck
```

Expected: transport retry/abort tests pass; no token appears in snapshots; callback strings fit 64 bytes; all rendered user text is escaped.

- [ ] **Step 8: Commit Telegram transport and views**

```bash
git add src/async.ts src/telegram tests/telegram-client.test.ts tests/telegram-view.test.ts tests/helpers.ts
git commit -m "feat: add Telegram transport and status views"
```

---

### Task 5: Pairing, Authorization, Project Picker, and Confirmation Ingress

**Files:**
- Create: `src/telegram/ingress.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/domain/models.ts`
- Create: `tests/telegram-ingress.test.ts`

**Interfaces:**
- Produces: `TelegramIngress.handleClaimed(update, now)`, pairing/project/start/cancel callback behavior, and replay-safe deterministic job/effect ids.
- Consumes: `TelegramClient`, views, store, `transition`, and enabled project policies.

- [ ] **Step 1: Write failing authorization and pairing tests**

```ts
it("reveals no project information to an unauthorized chat", async () => {
  const fixture = ingressFixture({ owner: { userId: "7", chatId: "70" } });
  await fixture.ingress.handleClaimed(updateWithMessage(1, 8, 80, "show projects"), 1_000);
  expect(fixture.telegram.sent).toEqual([]);
  expect(fixture.store.getActiveJob()).toBeNull();
});

it("pairs only a valid unconsumed code in a private chat", async () => {
  const fixture = ingressFixture({ pairingCode: "pair-code" });
  await fixture.ingress.handleClaimed(updateWithMessage(1, 7, 70, "/start pair-code"), 2_000);
  expect(fixture.store.getOwner()).toMatchObject({ userId: "7", chatId: "70" });
  await fixture.ingress.handleClaimed(updateWithMessage(2, 8, 80, "/start pair-code"), 2_001);
  expect(fixture.store.getOwner()?.userId).toBe("7");
});
```

- [ ] **Step 2: Add failing task draft, picker, confirmation, reply-steering, and dedupe tests**

Cover these exact cases:

- First authorized plain message creates `awaiting_project` and renders enabled aliases only.
- Last-used project changes order only; it does not select or confirm it.
- `p:<job>:<alias>` binds the project policy version and renders Start/Cancel.
- `s:<job>` starts only the selected confirmed job, commits the job/effect transition, then records the completed callback outcome. A crash before the callback record replays the same version/idempotency keys without duplicating work.
- Replayed update ids and callback ids produce no second job or effect; job ids derive deterministically from paired chat id plus Telegram update id.
- A standalone message while a job is active receives bounded guidance and is not forwarded.
- A reply to the active status message emits an agent-only `steer_implementation` effect with the reply text.
- Group, supergroup, channel, bot-authored, textless, malformed, and wrong-message callbacks expose no project data.

- [ ] **Step 3: Run ingress tests to verify RED**

Run: `npm test -- tests/telegram-ingress.test.ts`

Expected: FAIL because `TelegramIngress` and ingress store helpers do not exist.

- [ ] **Step 4: Implement ordered, deduplicated ingress**

```ts
export class TelegramIngress {
  async handleClaimed(update: TelegramUpdate, now: number): Promise<void> {
    if (update.message) return this.handleMessage(update.message, update.update_id, now);
    if (update.callback_query) return this.handleCallback(update.callback_query, update.update_id, now);
  }
}
```

The polling service claims/completes each update around `handleClaimed`; ingress itself never advances the cursor and receives no BB SDK, terminal, validation, GitHub, or merge adapter. `handleMessage` must process `/start <code>` before owner authorization, require `chat.type === "private"`, compare numeric ids as decimal strings, and ignore unauthorized input after bounded audit logging. Authorized commands are `/status`, `/cancel`, `/retry`, `/projects`, and `/help`. All other plain text follows the active-job/reply rules in Step 2. Use `stableJobId(chatId, updateId)` so a crash after job creation but before update completion reuses the same row and effect keys.

- [ ] **Step 5: Add job status-message and last-project store methods**

```ts
setJobStatusMessage(jobId: string, messageId: number, expectedVersion: number, now: number): Job;
setLastProject(projectId: string): Promise<void>;
getLastProject(): Promise<string | null>;
enqueueOutbox(item: OutboxInput, now: number): void;
```

Store `lastProject` in `bb.storage.kv` only if the store wrapper accepts an injected KV handle; the job and outbox remain SQLite-backed. A missing remembered project is ignored.

- [ ] **Step 6: Run ingress regressions to verify GREEN**

Run:

```bash
npm test -- tests/telegram-ingress.test.ts tests/job-store.test.ts
npm run typecheck
```

Expected: all ingress cases pass; unauthorized updates cannot infer alias count or names; duplicate Start produces one `spawn_implementation` effect.

- [ ] **Step 7: Commit authenticated Telegram ingress**

```bash
git add src/telegram/ingress.ts src/storage/store.ts src/domain/models.ts tests/telegram-ingress.test.ts
git commit -m "feat: add authenticated Telegram task ingress"
```

---

### Task 6: BB Worktree, Artifact Handoffs, Implementation Thread, and Fresh Review Child

**Files:**
- Create: `src/bb/handoffs.ts`
- Create: `src/bb/prompts.ts`
- Create: `src/bb/runner.ts`
- Create: `tests/bb-runner.test.ts`
- Create: `tests/handoffs.test.ts`
- Create: `tests/prompts.test.ts`

**Interfaces:**
- Produces: `buildWorkOrder`, `buildReviewPacket`, `BbRunner`, `spawnImplementation`, `spawnReview`, `sendRemediation`, `sendSteering`, `stopWorker`, `getThread`, `getEnvironmentSnapshot`, `getPullRequestSnapshot`.
- Consumes: `Job`, `ProjectPolicy`, and generated `BbSdk` methods.

Every call for an active job uses the immutable `job.policy` snapshot, never a fresh lookup of the operator's current project policy. Construct `BbRunner` only inside the effect-runner dependency graph; Telegram ingress, views, and lifecycle event callbacks must not receive it.

- [ ] **Step 1: Write failing spawn-argument tests against the fake BB SDK**

```ts
it("spawns a visible implementation thread in a named managed worktree", async () => {
  const { runner, sdkCalls } = runnerFixture({ spawnedEnvironmentId: "env_1" });
  await runner.spawnImplementation(jobFixture(), attemptFixture({ id: "attempt_impl_1" }), policyFixture({ baseBranch: "main" }));

  expect(sdkCalls.threadsSpawn[0]).toMatchObject({
    projectId: "proj_1",
    title: expect.stringContaining("attempt_impl_1"),
    visibility: "visible",
    environment: {
      type: "host",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "main" },
      },
    },
    input: [
      { type: "text", text: expect.stringContaining("Read the attached immutable work order") },
      { type: "localFile", name: expect.stringMatching(/work-order\.md$/) },
    ],
  });
  expect(sdkCalls.projectsAttachmentUpload).toHaveLength(1);
  expect(sdkCalls.threadsFork).toHaveLength(0);
});

it("spawns review as a visible child in the exact implementation environment", async () => {
  const { runner, sdkCalls } = runnerFixture();
  await runner.spawnReview(jobFixture({ environmentId: "env_1", implementationThreadId: "thr_i" }), attemptFixture({ id: "attempt_review_1" }), policyFixture());
  expect(sdkCalls.threadsSpawn[0]).toMatchObject({
    parentThreadId: "thr_i",
    title: expect.stringContaining("attempt_review_1"),
    visibility: "visible",
    environment: { type: "reuse", environmentId: "env_1" },
    input: [
      { type: "text", text: expect.stringContaining("Read the attached immutable review packet") },
      { type: "localFile", name: expect.stringMatching(/review-packet\.json$/) },
    ],
  });
  expect(sdkCalls.threadsFork).toHaveLength(0);
});
```

- [ ] **Step 2: Write failing handoff and tiny-prompt snapshot tests**

The work-order artifact must include request text, project/base, narrow outcome, investigate/fix/regression/check/commit/push/PR requirements, changed-files/tests/PR/SHA/blockers report, and no deployment. The review-packet artifact must include request, PR number/url, authoritative remote head SHA, complete non-truncated diff, validation policy, no-edit/no-commit/no-push/no-merge rules, and strict JSON-only output. Serialize the review packet as strict JSON so request and diff are unambiguously data fields. Each artifact returns a SHA-256 digest over its exact UTF-8 bytes.

The implementation and review prompt strings must remain under 400 characters, identify the attached filename/digest, and contain neither the Telegram request nor the diff. Add a regression proving a request/diff containing Markdown, XML, and fake system instructions remains only inside the serialized attachment. Remediation and format-correction prompts remain bounded inline messages.

- [ ] **Step 3: Run BB runner/prompt tests to verify RED**

Run: `npm test -- tests/bb-runner.test.ts tests/handoffs.test.ts tests/prompts.test.ts`

Expected: FAIL because the runner, handoff builders, and tiny prompt builders do not exist.

- [ ] **Step 4: Implement immutable handoff and tiny-prompt builders**

```ts
export type HandoffArtifact = {
  filename: string;
  mimeType: "text/markdown" | "application/json";
  bytes: Uint8Array;
  sha256: string;
};

export function buildWorkOrder(job: Job, policy: ProjectPolicy): HandoffArtifact;
export function buildReviewPacket(job: Job, policy: ProjectPolicy, remoteHeadSha: string, diff: string): HandoffArtifact;
export function buildImplementationInstruction(artifact: HandoffArtifact): string;
export function buildReviewInstruction(artifact: HandoffArtifact): string;
export function buildRemediationPrompt(job: Job, findings: ReviewFinding[]): string;
export function buildReviewFormatCorrectionPrompt(): string;
```

Build exact bytes with `TextEncoder` and hash those bytes. The work order is bounded Markdown; the review packet is schema-versioned JSON whose `request` and `diff` fields are ordinary JSON strings and whose instructions state they are requirements/source evidence, not higher-priority instructions. If `bb.sdk.environments.diff` reports `truncated: true`, block review rather than uploading or reviewing a partial diff. Never write either artifact into the repository or managed-worktree path.

- [ ] **Step 5: Implement exact BB SDK calls**

Define `summarize(text, max)` as whitespace collapse plus Unicode-safe truncation, and define `executionArgs(profile)` to copy only present `providerId`, `model`, `reasoningLevel`, `serviceTier`, and `permissionMode` values. When a value is copied, also set the matching `executionInputSources` field to `"explicit"`; when the profile is empty, return `{}` so BB resolves project defaults.

```ts
const artifact = buildWorkOrder(job, policy);
const uploaded = await bb.sdk.projects.attachments.upload({
  projectId: job.projectId!,
  clientFile: artifact.bytes,
  filename: artifact.filename,
  mimeType: artifact.mimeType,
});
const thread = await bb.sdk.threads.spawn({
  projectId: job.projectId!,
  title: `Telegram ${job.id} implementation ${attempt.id}`,
  visibility: "visible",
  input: [
    { type: "text", text: buildImplementationInstruction(artifact) },
    uploaded,
  ],
  environment: {
    type: "host",
    workspace: {
      type: "managed-worktree",
      baseBranch: { kind: "named", name: policy.baseBranch },
    },
  },
  ...executionArgs(policy.implementation),
});
```

Require the upload result to be `type: "localFile"`, and persist its returned path plus the locally computed digest on the attempt. The caller creates a deterministic attempt row before upload/spawn and passes it into the runner. Implementation and review titles contain that exact attempt id; review titles use `Telegram <jobId> review <attemptId>`. For review, upload the review packet and call `threads.spawn` with `input: [tinyText, uploaded]`, `parentThreadId`, `environment: { type: "reuse", environmentId }`, `visibility: "visible"`, and review execution arguments. Never call `threads.fork`, because it clones the implementation provider session. For remediation/follow-up call `threads.send({ threadId, mode: "auto", input: [{ type: "text", text }] })`. For cancellation call `threads.stop({ threadId })`. Read live state with `threads.get`, `environments.status({ environmentId, mergeBaseBranch })`, `environments.diff({ environmentId, target: "all", mergeBaseBranch })`, and `environments.pullRequest({ environmentId })` exactly as generated types require.

- [ ] **Step 6: Run BB adapter tests and typecheck to verify GREEN**

Run:

```bash
npm test -- tests/bb-runner.test.ts tests/handoffs.test.ts tests/prompts.test.ts
npm run typecheck
```

Expected: exact attachment/spawn/send/stop/status/diff/PR calls are recorded; request/diff content stays out of tiny prompts and the Git worktree; omitted execution fields remain omitted; review cannot use a different environment or provider conversation inherited by forking.

- [ ] **Step 7: Commit BB orchestration adapter**

```bash
git add src/bb/handoffs.ts src/bb/prompts.ts src/bb/runner.ts tests/bb-runner.test.ts tests/handoffs.test.ts tests/prompts.test.ts
git commit -m "feat: add BB implementation and review threads"
```

---

### Task 7: Strict Review Verdict and Remediation Loop

**Files:**
- Create: `src/domain/review.ts`
- Modify: `src/domain/models.ts`
- Create: `src/services/review-handler.ts`
- Create: `tests/review.test.ts`
- Create: `tests/review-loop.test.ts`

**Interfaces:**
- Produces: `reviewVerdictSchema`, `parseReviewVerdict(text)`, `assessReview(verdict, expectedSha)`, and effect handling for review completion/remediation.
- Consumes: BB runner prompts/methods, state machine, store attempts.

- [ ] **Step 1: Write failing strict-parser tests**

```ts
it("accepts one strict JSON object for the expected head", () => {
  const text = JSON.stringify({
    verdict: "pass",
    reviewedHeadSha: "a".repeat(40),
    summary: "No actionable findings",
    findings: [],
    checks: [{ name: "unit", command: "npm test", outcome: "passed", exitCode: 0, summary: "12 passed" }],
  });
  expect(parseReviewVerdict(text).verdict).toBe("pass");
});

it.each([
  "```json\n{}\n```",
  "preface {}",
  JSON.stringify({ verdict: "pass", reviewedHeadSha: "bad", summary: "x", findings: [], checks: [] }),
])("rejects non-contract review output", (text) => {
  expect(() => parseReviewVerdict(text)).toThrow();
});

it("does not assess a nominal pass with findings as PASS", () => {
  const verdict = reviewVerdictSchema.parse({
    verdict: "pass",
    reviewedHeadSha: "a".repeat(40),
    summary: "finding remains",
    findings: [{ severity: "high", file: "src/a.ts", line: 1, title: "bug", details: "evidence" }],
    checks: [],
  });
  expect(assessReview(verdict, "a".repeat(40)).outcome).toBe("changes_requested");
});
```

- [ ] **Step 2: Write failing review-loop tests**

Cover PASS for exact SHA, changes requested with sorted findings, blocked checks, wrong SHA, reviewer worktree mutation, one format-correction turn, second invalid output, remediation sent to original implementation thread, required new head before a later PASS, and fresh child thread on every review cycle.

- [ ] **Step 3: Run review tests to verify RED**

Run: `npm test -- tests/review.test.ts tests/review-loop.test.ts`

Expected: FAIL because the schema/parser/review effects do not exist.

- [ ] **Step 4: Implement the strict Zod contract**

```ts
export const reviewVerdictSchema = z.object({
  verdict: z.enum(["pass", "changes_requested", "blocked"]),
  reviewedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  summary: z.string().min(1).max(2_000),
  findings: z.array(z.object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    title: z.string().min(1).max(200),
    details: z.string().min(1).max(2_000),
  }).strict()).max(100),
  checks: z.array(z.object({
    name: z.string().min(1).max(100),
    command: z.string().nullable(),
    outcome: z.enum(["passed", "failed", "blocked"]),
    exitCode: z.number().int().nullable(),
    summary: z.string().min(1).max(1_000),
  }).strict()).max(50),
}).strict();

export function parseReviewVerdict(text: string): ReviewVerdict {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new InvalidReviewOutputError();
  return reviewVerdictSchema.parse(JSON.parse(trimmed));
}
```

`assessReview` returns PASS only when SHA matches, findings are empty, every reported check passed, and `verdict === "pass"`; every other combination maps to changes requested or blocked with explicit reasons.

- [ ] **Step 5: Implement review attempt handling**

On `thread.idle` for the current review thread:

1. Read `bb.sdk.threads.output` and current environment status.
2. Fail the attempt if status is unavailable, dirty, or HEAD differs from the pre-review SHA.
3. Parse strict JSON.
4. On first parse failure, send `buildReviewFormatCorrectionPrompt()` to the same review thread and mark `formatCorrectionSent` in the attempt result.
5. On second parse failure, emit `REVIEW_BLOCKED`.
6. On changes requested, persist findings and emit `REVIEW_CHANGES_REQUESTED`.
7. On PASS, persist the verdict and emit `REVIEW_PASSED` for the exact head.

- [ ] **Step 6: Run review and prior state tests to verify GREEN**

Run:

```bash
npm test -- tests/review.test.ts tests/review-loop.test.ts tests/state-machine.test.ts
npm run typecheck
```

Expected: all strict-contract and remediation cases pass; a review cannot pass after mutating the worktree or against an older SHA.

- [ ] **Step 7: Commit independent review handling**

```bash
git add src/domain/review.ts src/domain/models.ts src/services/review-handler.ts tests/review.test.ts tests/review-loop.test.ts
git commit -m "feat: enforce independent review contract"
```

---

### Task 8: Environment-Scoped Command Runner, Git-Native Head Truth, GitHub Metadata, and Merge Gates

**Files:**
- Create: `src/bb/terminal-command.ts`
- Create: `src/bb/validation.ts`
- Create: `src/domain/gates.ts`
- Create: `tests/terminal-command.test.ts`
- Create: `tests/validation.test.ts`
- Create: `tests/gates.test.ts`

**Interfaces:**
- Produces: `TerminalCommandRunner.run`, `parseGitHubRemote`, `parseLsRemoteHead`, `resolvePrHead`, `ValidationSnapshot`, `GitHubPrSnapshot`, `RequiredCheck`, `runValidation`, `evaluateMergeGates`.
- Consumes: generated terminal/environment SDK, current review attempt, `Job`, and `ProjectPolicy`.

- [ ] **Step 1: Write failing terminal runner tests**

Assert exact environment scope, command mode, 120x40 dimensions, exit polling, base64 decoding, 64 KiB tail cap, timeout force-close, abort handling, ANSI stripping, and preservation of nonzero exit codes. A timeout result is `{ outcome: "timed_out" }`; it is never reported as an exit code 0.

- [ ] **Step 2: Write failing validation and GitHub snapshot tests**

Use these exact commands with the numeric PR interpolated as decimal digits only:

```bash
git remote get-url origin
git ls-remote --exit-code origin refs/pull/17/head
gh pr view 17 --json number,url,state,isDraft,baseRefName,headRefName,mergeStateStatus,mergeable,reviewDecision,changedFiles,additions,deletions,mergeCommit,mergedAt
gh pr checks 17 --required --json name,bucket,state,link
git ls-remote --exit-code origin refs/pull/17/head
```

Test HTTPS and SSH origin normalization, origin/repository mismatch, missing/multiple/malformed `ls-remote` rows, a wrong ref name, upper/lowercase repository identity, malformed `gh` JSON, missing configured check names, `pass`, `fail`, `pending`, `skipping`, `cancel`, command timeout, remote head changing between the two Git lookups, and a dirty worktree after validation. `gh pr checks` exit 0, 1, and its documented pending exit 8 must still parse strict JSON and derive readiness from `bucket`; any other exit is an infrastructure failure. Add a regression where `gh` fixture data contains a deliberately stale `headRefOid`: the strict non-head PR schema must reject that unexpected field, no mapped type may expose it, and the gate's only remote-head input must come from `parseLsRemoteHead`.

- [ ] **Step 3: Write failing pure merge-gate tests**

Create one ready fixture, then independently vary each gate: wrong project/environment, unavailable status, dirty/untracked worktree, detached/unknown checkout, origin/repository mismatch, local head mismatch, absent/unavailable/draft/closed PR, wrong base, missing/malformed/multiple remote-head rows, remote head mismatch, remote head movement during collection, conflicts/blocked/unknown mergeability, reviewer mutation, review wrong SHA/findings, validation wrong SHA/failure, missing/failing/pending required check, cancellation, stale job version, and expired receipt. Verify aggregate `no_checks` is allowed only when `requiredChecks` is empty; unknown, pending, failing, cancelled, or missing required checks block.

- [ ] **Step 4: Run terminal/validation/gate tests to verify RED**

Run: `npm test -- tests/terminal-command.test.ts tests/validation.test.ts tests/gates.test.ts`

Expected: FAIL because the environment runner, GitHub parsers, and gate evaluator do not exist.

- [ ] **Step 5: Implement bounded environment terminal execution**

```ts
export class TerminalCommandRunner {
  async run(input: {
    scope:
      | { kind: "environment"; environmentId: string }
      | { kind: "host_path"; hostId: string; cwd: string | null };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult> {
    const session = await this.sdk.terminals.create({
      cols: 120,
      rows: 40,
      scope: input.scope,
      start: { mode: "command", command: input.command },
      title: input.title,
    });
    return this.waitForExitAndCollectTail(session.id, input.timeoutMs, input.signal);
  }
}
```

Poll `terminals.get` with an abortable 250 ms delay. On exit call `terminals.output({ terminalId, tailBytes: 65_536 })`, concatenate chunks by sequence, decode base64, strip ANSI control sequences, and return the session exit code. On timeout call `terminals.close({ terminalId, mode: "force" })` once. Never place Telegram text in `command`.

- [ ] **Step 6: Implement validation and GitHub truth collection**

`runValidation` must:

1. Read `environments.status` and require available, clean, branch checkout, and non-null head.
2. Run `git remote get-url origin`, normalize supported credential-free GitHub HTTPS/SSH forms to `owner/repository`, and require an exact case-insensitive match with immutable `job.policy.githubRepository`. Reject URL userinfo/embedded credentials; never persist or render the raw remote output, and redact it before constructing any error.
3. Run the first `git ls-remote --exit-code origin refs/pull/<number>/head`. Require exit 0 and exactly one row whose second field is that exact ref; parse its full lowercase OID as `remoteHeadSha` and require it equals local environment HEAD.
4. Run policy validation commands sequentially and stop on first non-pass while retaining prior receipts.
5. Run the fixed `gh pr view` and `gh pr checks` commands above using the numeric PR. Their strict schemas expose PR/check metadata but no authoritative head field. Parse `gh pr checks` JSON for exits 0, 1, and 8, then use `bucket` as the check outcome; other exits fail collection.
6. Run the same `git ls-remote` command again and require the identical OID, proving the head did not move while commands/checks were collected.
7. Redact command output with generic bearer/GitHub-token/private-key patterns plus every compiled `policy.outputRedactionPatterns`; reject an invalid configured regular expression when the policy is saved.
8. Read environment status again and require the same clean head.
9. Return a snapshot containing `headSha` sourced from `ls-remote`, origin repository identity, command receipts, GitHub PR fields, required checks, and `completedAt`.

Do not shell-escape policy commands by concatenating user data; each policy command is already a full owner-authored command. PR ids use `String(number)` after an integer schema check. Never fall back from `ls-remote` to `gh`, `environments.pullRequest`, the review verdict, or a recorded job SHA.

The `resolve_pr_head` effect uses the same origin-normalization and strict `ls-remote` parser before any review exists. It requires local clean HEAD to equal the remote OID, then emits `PR_HEAD_RESOLVED`; missing/mismatched/moving refs emit a typed failure and cannot spawn review. `runValidation` reuses this implementation rather than introducing a second head resolver.

- [ ] **Step 7: Implement the pure gate evaluator**

```ts
export type GateEvaluation =
  | { ready: false; reasons: GateReason[] }
  | { ready: true; receipt: MergeReadyReceipt };

export function evaluateMergeGates(input: GateInput): GateEvaluation;
```

The ready branch requires all ten approved design gates. It binds `jobId`, `jobVersion`, `projectId`, `environmentId`, `prNumber`, `baseBranch`, full `headSha`, review attempt id, validation completion time, sorted required check names, merge method, and `expiresAt`. Return every blocking reason in stable code order so Telegram and CLI can explain the exact gap.

- [ ] **Step 8: Run focused validation/gate tests to verify GREEN**

Run:

```bash
npm test -- tests/terminal-command.test.ts tests/validation.test.ts tests/gates.test.ts
npm run typecheck
```

Expected: all command lifecycle and individual gate mutations pass; the two `ls-remote` OIDs, local environment HEAD, review verdict, validation receipt, and ready receipt are identical, while stale `gh` head metadata cannot influence readiness.

- [ ] **Step 9: Commit deterministic validation and gates**

```bash
git add src/bb/terminal-command.ts src/bb/validation.ts src/domain/gates.ts tests/terminal-command.test.ts tests/validation.test.ts tests/gates.test.ts
git commit -m "feat: add deterministic PR merge gates"
```

---

### Task 9: Expiring Telegram Approval and Idempotent BB PR Merge

**Files:**
- Modify: `src/storage/store.ts`
- Create: `src/services/approval-service.ts`
- Create: `src/services/merge-handler.ts`
- Modify: `src/telegram/ingress.ts`
- Modify: `src/telegram/view.ts`
- Create: `tests/approval.test.ts`
- Create: `tests/merge.test.ts`

**Interfaces:**
- Produces: `issueApproval`, `consumeApproval`, merge callback behavior, and durable merged outcome.
- Consumes: `evaluateMergeGates`, `bb.sdk.environments.mergePullRequest`, validation runner, outbox.

- [ ] **Step 1: Write failing approval tests**

```ts
it("stores only a hash and consumes an approval once for its exact head", () => {
  const fixture = approvalFixture({ now: 1_000 });
  const issued = fixture.service.issue("job_1", "a".repeat(40));
  const row = fixture.db.prepare("SELECT nonce_hash FROM approvals").get();
  expect(JSON.stringify(row)).not.toContain(issued.nonce);
  expect(fixture.service.consume(issued.nonce, 2_000)).toMatchObject({ ok: true, headSha: "a".repeat(40) });
  expect(fixture.service.consume(issued.nonce, 2_001)).toEqual({ ok: false, reason: "consumed" });
});
```

Also test wrong paired identity, expiry at exactly fifteen minutes, revoked job, changed job version, cancelled job, callback replay, and transaction rollback when consumption loses a race.

- [ ] **Step 2: Write failing merge-path tests**

Cover fresh gate success, stale local head, stale `gh` head metadata that matches an old verdict, stale or malformed `git ls-remote` head, remote head movement after approval acceptance but before the merge effect, pending check, merge conflict, SDK merge rejection, SDK success followed by Git-native head plus `gh pr view` state confirmation, Telegram delivery failure after merge, and retry after that delivery failure. Assert one `mergePullRequest({ environmentId, method })` call maximum.

- [ ] **Step 3: Run approval/merge tests to verify RED**

Run: `npm test -- tests/approval.test.ts tests/merge.test.ts`

Expected: FAIL because approval storage and merge effects do not exist.

- [ ] **Step 4: Implement hashed approval persistence**

```ts
createApproval(input: { nonceHash: string; jobId: string; headSha: string; expiresAt: number; now: number }): void;
getUsableApproval(nonceHash: string, now: number): { jobId: string; headSha: string; expiresAt: number } | null;
consumeApproval(input: { nonceHash: string; now: number }):
  | { ok: true; jobId: string; headSha: string }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "revoked" };
acceptApprovalAndEnqueueMerge(input: { nonceHash: string; expectedJobVersion: number; effect: JobEffect; now: number }):
  | { ok: true; jobId: string; headSha: string }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "revoked" | "version_conflict" };
revokeApprovals(jobId: string, reason: string, now: number): number;
```

`consumeApproval` supports focused domain tests. Production merge callbacks use `acceptApprovalAndEnqueueMerge`, which updates `consumed_at`/`outcome = 'accepted'`, guards the job version/head, and inserts the unique `merge_pr` effect in one transaction. A crash can therefore leave neither action or both actions, never a consumed approval without durable merge work.

- [ ] **Step 5: Implement approval issue/render/callback handling**

Generate a 24-byte nonce, store only SHA-256, bind full head, expire at `now + 15 * 60_000`, and render `m:<nonce>`. The merge callback must verify owner/chat and check whether the callback already has a completed outcome, read the usable approval without consuming it, reload job/policy, collect an entirely fresh validation snapshot—including two Git-native remote-head lookups—and call `evaluateMergeGates`. Any failed gate emits `APPROVAL_STALE` or `VALIDATION_FAILED`, revokes the nonce, and then records the callback outcome without a merge effect. A ready evaluation is passed to `acceptApprovalAndEnqueueMerge`; after that transaction commits, record the callback outcome. Replays observe the consumed nonce plus existing merge effect and return the same accepted outcome without creating another effect.

- [ ] **Step 6: Implement merge effect and post-merge confirmation**

The `merge_pr` effect must reload the current job and run the complete fresh validation/gate collection one final time after it is leased and immediately before the SDK merge call. This second evaluation must include a new `git ls-remote` result equal to the accepted approval receipt. Any drift completes the effect with `APPROVAL_STALE` and creates a new review/validation path; it never calls merge and never substitutes `gh`'s head field.

```ts
await bb.sdk.environments.mergePullRequest({
  environmentId: receipt.environmentId,
  method: receipt.mergeMethod,
});
```

Then run `git ls-remote --exit-code origin refs/pull/<number>/head` and `gh pr view <number> --json state,mergedAt,mergeCommit,url,number` in the same environment. Persist `MERGE_SUCCEEDED` only when the Git-native ref still equals the approved head, state is `MERGED`, and `mergedAt` and `mergeCommit` are non-null. Save bounded merge JSON plus the authoritative OID in the attempt result before enqueuing Telegram completion. If Telegram fails, retry only outbox delivery; never recreate the merge effect.

- [ ] **Step 7: Run approval, merge, and gate regressions to verify GREEN**

Run:

```bash
npm test -- tests/approval.test.ts tests/merge.test.ts tests/gates.test.ts
npm run typecheck
```

Expected: all stale/replay/failure cases fail closed; successful merge produces one SDK merge call and one durable merged job.

- [ ] **Step 8: Commit human-approved merge execution**

```bash
git add src/storage/store.ts src/services/approval-service.ts src/services/merge-handler.ts src/telegram/ingress.ts src/telegram/view.ts tests/approval.test.ts tests/merge.test.ts
git commit -m "feat: require fresh Telegram merge approval"
```

---

### Task 10: Pure Telegram Ingress, Single Leased Executor, Liveness, Reconciliation, and Outbox Recovery

**Files:**
- Create: `src/services/effect-runner.ts`
- Create: `src/services/telegram-service.ts`
- Create: `src/services/worker-liveness.ts`
- Create: `src/services/job-executor-service.ts`
- Create: `src/errors.ts`
- Modify: `src/plugin.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/telegram/view.ts`
- Create: `tests/effect-runner.test.ts`
- Create: `tests/telegram-service.test.ts`
- Create: `tests/worker-liveness.test.ts`
- Create: `tests/job-executor-service.test.ts`
- Modify: `tests/plugin.test.ts`
- Modify: `tests/telegram-view.test.ts`

**Interfaces:**
- Produces: two BB background services named `telegram-ingress` and `job-executor`, a singleton generation-fenced executor lease, durable effect/outbox leases, one BB-owned liveness projection, and event-triggered reconciliation.
- Consumes: all domain/adapters from Tasks 2-9 and live global settings.

- [ ] **Step 1: Write failing long-poll lifecycle tests**

Test SQLite cursor advancement only after completion, ordered processing, replay after a crash between durable job creation and completion, duplicate processed update, polling abort, same-bot token rotation via `settings.onChange`, different-bot identity change, 429 retry, and no second loop after plugin reload. Construct Telegram-service dependencies without any BB runner, environment, terminal, attachment, GitHub, or merge capability and assert a Start update only persists a `spawn_implementation` effect. Use fake timers; no real sleep.

- [ ] **Step 2: Write failing reconciliation/effect/outbox tests**

Cover:

- two executor instances race for one singleton lease and exactly one wins;
- a successor increments the lease generation only after expiry, while the stale owner cannot renew, claim, or complete effects;
- two pending effects for the active job still execute sequentially under one executor rather than being split across workers;
- startup resumes every nonterminal job;
- `thread.idle` and `thread.failed` for unrelated threads do nothing;
- matching implementation/review events enqueue one reconciliation effect;
- expired `leased` effects/outbox rows become eligible once;
- effect failure uses capped jittered backoff and preserves idempotency key;
- the twentieth transient failure and the first permanent failure dead-letter exactly once and appear in job/CLI status;
- status rendering sends once, then edits the stored message id;
- Telegram send success atomically stores `statusMessageId` before outbox completion;
- plugin restart between external success and local completion reconciles live BB/PR state without duplicating a thread or merge;
- an expired spawn claim adopts one exact plugin-origin/attempt-title thread, retries after zero, and blocks on multiple or structurally mismatched candidates;
- cancellation confirms only after BB thread state is idle or error.
- a stop timeout leaves the job blocked with its approval revoked; it never reports `cancelled` while the worker remains active or stopping.
- implementation and review liveness map only from fresh BB thread status/runtime fields; terminal liveness maps only from terminal status/deadline;
- old BB `updatedAt` becomes a `stale` warning after `workerLivenessWatchdogMs`, but does not declare death, retry, spawn a replacement, release the active-job slot, or merge;
- host reconnect/waiting states and BB lookup failure become `unknown`, emit one bounded owner alert, and prohibit Retry/Continue until a fresh authoritative state is observed;
- Git changes, output age, Telegram timestamps, and provider prose cannot alter liveness.
- Telegram status shows the single worker resource id, liveness state, and source observation age; stale/unknown warnings contain no speculative diagnosis.

- [ ] **Step 3: Run service tests to verify RED**

Run: `npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts`

Expected: FAIL because services and complete plugin wiring do not exist.

- [ ] **Step 4: Implement lease APIs and bounded retry policy**

Add:

```ts
acquireExecutorLease(ownerId: string, now: number, leaseMs: number): { acquired: true; generation: number } | { acquired: false };
renewExecutorLease(ownerId: string, generation: number, now: number, leaseMs: number): boolean;
releaseExecutorLease(ownerId: string, generation: number, now: number): boolean;
leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredEffect[];
leaseOutbox(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredOutbox[];
completeEffect(key: string, ownerId: string, generation: number, now: number): boolean;
completeOutbox(key: string, ownerId: string, generation: number, messageId: number | null, now: number): boolean;
failEffect(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean;
failOutbox(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean;
deadLetterEffect(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
deadLetterOutbox(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
```

Acquire/renew the singleton lease in an immediate SQLite transaction. A new owner can acquire only when unowned or expired and increments `generation`; renewal/completion requires the exact owner and generation. Claim oldest eligible rows only while that fence is current, set `status = 'leased'`, `lease_owner`, `lease_generation`, `lease_expires_at`, and increment attempts. Execute claimed effects sequentially. Retry delay is `min(30_000, 500 * 2^(attempts-1)) + injectedJitter(0..250)`. After twenty transient attempts, dead-letter the row and expose its bounded error through job/CLI status; schema/authorization/idempotency conflicts are dead-lettered immediately. Expected domain failures such as a stale head emit a job event and complete the effect rather than entering infrastructure retry.

- [ ] **Step 5: Implement the effect runner as the only external-action dispatcher**

Use an exhaustive switch over every `JobEffect["kind"]`. The effect runner is the only object graph that receives `BbRunner`, `TerminalCommandRunner`, project attachments, validation, GitHub, and merge dependencies. Each handler must first confirm the executor fence, reload the job, and confirm the effect still matches current state/version before external work. Thread creation records returned ids through a guarded job event before marking the effect done.

On an expired thread-spawn claim, paginate `threads.list({ projectId, originPluginId: "telegram-agent", includeHidden: true, limit, offset })` over a bounded maximum of 1,000 plugin-attributed threads and match the exact deterministic attempt-id title before considering another spawn. One structurally valid match is adopted into the guarded attempt/job; zero permits a retry only after reconciliation completes; multiple matches or a match with the wrong project/environment/parent blocks as split-brain evidence. Merge follows Task 9's final pre-merge gate and post-confirmation rule. Unknown effect kinds are compile-time `never` and runtime permanent failures.

- [ ] **Step 6: Implement abortable Telegram polling**

Add the only background-service error helpers:

```ts
// src/errors.ts
export function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]").slice(0, 1_000);
}
```

```ts
export async function runTelegramService(deps: TelegramServiceDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const config = deps.getConfig();
    if (!config.ok) throw needsConfiguration(config.message);
    const offset = deps.store.getNextTelegramOffset();
    const updates = await deps.client(config.value.botToken).getUpdates(offset, config.value.pollTimeoutSeconds, signal);
    for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
      const now = deps.clock.now();
      const claim = deps.store.beginTelegramUpdate(update.update_id, now);
      if (claim === "processed") continue;
      try {
        await deps.ingress.handleClaimed(update, now);
        deps.store.completeTelegramUpdate(update.update_id, "processed", deps.clock.now());
      } catch (error) {
        deps.store.failTelegramUpdate(update.update_id, redactError(error), deps.clock.now());
        throw error;
      }
    }
  }
}
```

`completeTelegramUpdate` atomically sets status to processed and advances `telegram_cursor.next_offset` to `update_id + 1`; failure marks the row failed but leaves the cursor unchanged so Telegram redelivers the update. `beginTelegramUpdate` reclaims failed rows by setting them to processing and incrementing attempts. Processing is sequential, so a later update can never advance past an earlier failure. The token lives only in the in-memory config closure and client instance. No service diagnostic prints it.

Wrap the `getUpdates` call so `TelegramConflictError` becomes `NeedsConfigurationError` with `Another process is polling this Telegram bot token.`; the service must stop restarting until configuration/reload rather than competing indefinitely.

Before the first poll for each in-memory token generation, call `getMe` and `bindTelegramIdentity`. The same numeric bot id keeps the cursor and pairing. A different bot id with an active job returns `active_job_conflict` and stops with `NeedsConfigurationError`. A different bot id without an active job transactionally revokes the old owner/approvals, deletes old pairing codes, clears update/callback history, resets cursor to zero, stores the new id/username, and requires a new pairing. Never compare bot identity by username alone.

- [ ] **Step 7: Implement the single-source worker-liveness projection**

Add exact store methods:

```ts
upsertWorkerLiveness(value: WorkerLiveness): void;
getWorkerLiveness(jobId: string): WorkerLiveness | null;
markWorkerLivenessNotified(jobId: string, generation: number, now: number): boolean;
clearWorkerLiveness(jobId: string, generation: number): boolean;
```

The generation guard prevents a late observation from an older review/terminal from replacing the current worker. `observeThreadWorker(job, thread, now)` maps only fresh BB fields:

- BB `starting` or runtime `provisioning` -> `starting`;
- BB `active` with ordinary runtime -> `active`;
- BB `stopping` -> `stopping`;
- BB `idle` -> `idle`;
- BB `error` -> `failed`;
- runtime `host-reconnecting`/`waiting-for-host` or a failed `threads.get` -> `unknown`.

Persist `thread.id` as resource id, the guarded job version that registered this worker as its monotonically increasing generation, `thread.updatedAt` as source timestamp, and the plugin clock only as observation time. If BB still reports an active-like state but `now - thread.updatedAt > job.policy.workerLivenessWatchdogMs`, project `stale` and enqueue one bounded warning per stale episode. This is explicitly an observation-gap warning, not proof of death. `unknown`/`stale` keeps the current job active, disables Retry/Continue and merge, and never stops or replaces the thread. A later fresh BB state clears the warning and resumes ordinary reconciliation. Validation/merge terminal liveness comes only from `terminals.get`; explicit command timeout becomes `failed`, never a fabricated heartbeat.

- [ ] **Step 8: Implement the singleton job-executor/reconciliation/outbox loop**

Create a random executor owner id per service start. Acquire a 30-second singleton lease, start a separate abortable heartbeat loop that renews every ten seconds, and pass its generation plus a lease-loss signal to the effect runner. If renewal fails, abort local work, do not complete claimed rows, and return to acquisition; a successor must reconcile live BB/GitHub state before reclaiming expired effects.

While the lease is held, every five seconds while jobs/effects/outbox exist and every sixty seconds while idle:

1. Confirm/renew the executor fence.
2. Reconcile the active job and its liveness from fresh BB thread/environment state.
3. Lease and run at most five effects sequentially, checking the fence before each.
4. Lease and deliver at most ten outbox items sequentially, checking the fence before each.
5. Sleep with an abortable timer.

All job progress uses one outbox logical key, `job:<jobId>:status`. Enqueue is an upsert of desired content: the first delivery calls `sendMessage`, stores the returned Telegram message id on the job, and later deliveries call `editMessageText`. Callback answers use separate `callback:<callbackQueryId>` keys. Completion of a terminal job does not create a second status message. Release the singleton lease on clean shutdown only when owner and generation still match.

Event handlers call `store.enqueueReconcileForThread(thread.id, now)` and return immediately. The periodic loop remains authoritative when events are missed. No event callback receives the BB runner or can execute the queued effect.

- [ ] **Step 9: Wire settings, services, events, and disposal in `createPlugin`**

Register exactly:

```ts
bb.background.service("telegram-ingress", { start: (signal) => runTelegramService(deps, signal) });
bb.background.service("job-executor", { start: (signal) => runJobExecutorService(deps, signal) });
bb.events.on("thread.created", ({ thread }) => queueThreadReconcile(thread));
bb.events.on("thread.active", ({ thread }) => queueThreadReconcile(thread));
bb.events.on("thread.idle", ({ thread }) => queueThreadReconcile(thread));
bb.events.on("thread.failed", ({ thread, error }) => queueThreadFailure(thread, error));
bb.events.on("thread.archived", ({ thread }) => queueThreadReconcile(thread));
bb.events.on("thread.deleted", ({ thread }) => queueThreadReconcile(thread));
```

Also register `settings.onChange` to atomically replace the parsed in-memory config. All six thread callbacks only perform the same bounded, idempotent reconciliation enqueue; they never update liveness directly or call external adapters.

- [ ] **Step 10: Run service and full current suite to verify GREEN**

Run:

```bash
npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
npm test
npm run typecheck
```

Expected: all tests pass; fake timers have no leaked handles; reload/abort completes; a lease race has one winner; a stale generation cannot mutate rows; one active job recovers without duplicate external actions; stale/unknown liveness never spawns a replacement.

- [ ] **Step 11: Commit resilient background orchestration**

```bash
git add src/errors.ts src/services src/plugin.ts src/storage/store.ts src/telegram/view.ts tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts tests/telegram-view.test.ts
git commit -m "feat: add resilient Telegram job services"
```

---

### Task 11: Operator CLI, Secure Policy Files, and Doctor Checks

**Files:**
- Create: `src/cli.ts`
- Modify: `src/plugin.ts`
- Create: `tests/cli.test.ts`
- Create: `tests/doctor.test.ts`

**Interfaces:**
- Produces: one `bb telegram-agent` command with pairing, project, job, and doctor operations.
- Consumes: store, BB projects/environments/files/terminals/providers, command runner, JSON serializers.

- [ ] **Step 1: Write failing CLI parser and output tests**

Test these commands and JSON variants:

```text
bb telegram-agent pair
bb telegram-agent unpair
bb telegram-agent project list
bb telegram-agent project enable <project-id> --policy-json '<json>'
bb telegram-agent project enable <project-id> --policy-file /absolute/path.json [--host <host-id>]
bb telegram-agent project enable <project-id> --alias <slug> --base <branch> --merge-method <merge|rebase|squash> [execution, liveness, and validation flags]
bb telegram-agent project disable <project-id>
bb telegram-agent job list [--limit 1-100]
bb telegram-agent job show <job-id>
bb telegram-agent job retry <job-id>
bb telegram-agent job cancel <job-id>
bb telegram-agent doctor [<project-id>]
```

Assert unknown/missing/duplicate flags exit 2, secret fields never print, collections are bounded, human output is concise, and JSON output is strict JSON.

- [ ] **Step 2: Write failing multi-machine policy-file tests**

Cover absolute path on primary host, explicit `--host`, thread-context environment host resolution, refusal of a relative path, missing `ctx.cwd`, BB file read failure, invalid JSON, and schema-invalid policy. Assert no `node:fs` import exists in `src/cli.ts`.

- [ ] **Step 3: Write failing doctor tests**

Doctor reports individual pass/fail rows for token presence, owner pairing, enabled project, standard Git project/source, default execution options/provider availability, source host/path, `gh auth status`, `gh repo view`, and PR merge SDK availability. Run `gh` checks through `TerminalCommandRunner` with `{ kind: "host_path", hostId, cwd: source.path }`; never expose auth output beyond a bounded success/failure summary.

- [ ] **Step 4: Run CLI tests to verify RED**

Run: `npm test -- tests/cli.test.ts tests/doctor.test.ts`

Expected: FAIL because the CLI command is not registered.

- [ ] **Step 5: Implement strict argv parsing and safe file routing**

```ts
bb.cli.register({
  name: "telegram-agent",
  summary: "Pair Telegram and manage reviewed BB implementation jobs",
  commands: [
    { name: "pair", summary: "Create a one-use Telegram pairing link", usage: "bb telegram-agent pair [--json]" },
    { name: "project", summary: "Manage enabled BB project policies", usage: "bb telegram-agent project <list|enable|disable> ..." },
    { name: "job", summary: "Inspect, retry, or cancel jobs", usage: "bb telegram-agent job <list|show|retry|cancel> ..." },
    { name: "doctor", summary: "Check Telegram, BB, host, provider, and GitHub readiness", usage: "bb telegram-agent doctor [project-id] [--json]" },
  ],
  run: (argv, ctx) => runTelegramAgentCli(deps, argv, ctx),
});
```

For `--policy-file`, require either a POSIX absolute path beginning `/` or a Windows drive path matching `^[A-Za-z]:[\\/]`. Resolve `hostId` from explicit `--host`; otherwise, when `ctx.threadId` exists, get its environment and host; otherwise omit `hostId` to use BB's primary host. Read with `bb.sdk.files.read({ ...(hostId ? { hostId } : {}), path, signal: ctx.signal })`. Do not normalize the remote path with server-local path libraries and do not log file contents.

Before enabling a policy, call `bb.sdk.projects.get({ projectId })` and require `kind === "standard"`, a non-null GitHub remote URL, and at least one local or cloned source. Normalize HTTPS/SSH GitHub remotes to canonical `owner/repository` and store it as `githubRepository`. Confirm the policy base branch appears in `bb.sdk.projects.branches({ projectId })`; a missing project, personal project, non-GitHub remote, source-less project, or missing base branch exits 1 without storing the policy.

Require the parsed policy's `projectId` to equal the positional `<project-id>` exactly. `--policy-json`, `--policy-file`, and individual policy fields are three mutually exclusive input modes. For JSON/file input, reject a supplied `githubRepository` that differs from the live canonical project remote, then parse an object augmented with that canonical value; omission is allowed at the CLI boundary even though the stored schema requires it. Individual mode derives the value and requires `--alias`, `--base`, and `--merge-method`; supports repeatable `--validation-json '{"name":"unit","command":"npm test","timeoutMs":600000}'`, `--required-check <name>`, and `--redact-pattern <regex>`; supports `--worker-liveness-watchdog-ms 60000-3600000` and `--max-review-cycles 1-10`; and supports implementation/review `--provider`, `--model`, `--reasoning`, `--service-tier`, and `--permission-mode` flags with `implementation-` or `review-` prefixes. Parse the constructed object through the same `projectPolicySchema` as JSON/file input.

- [ ] **Step 6: Implement pairing and job mutations with confirmation-safe outputs**

`pair` creates a 24-byte secret, stores its hash with ten-minute expiry, and prints `https://t.me/<botUsername>?start=<secret>` only after resolving the username with Telegram `getMe`. The CLI result labels it sensitive and expiring; logs never include it. `unpair` revokes owner and all approvals. Retry/cancel use the same state-machine events as Telegram and reject illegal states or version conflicts.

- [ ] **Step 7: Run CLI and full type verification to verify GREEN**

Run:

```bash
npm test -- tests/cli.test.ts tests/doctor.test.ts
npm run typecheck
```

Expected: all parser/routing/doctor cases pass; plugin command metadata is complete; no secret appears in logs or JSON snapshots.

- [ ] **Step 8: Commit operator tooling**

```bash
git add src/cli.ts src/plugin.ts tests/cli.test.ts tests/doctor.test.ts
git commit -m "feat: add Telegram agent operator CLI"
```

---

### Task 12: End-to-End Regression, Documentation, Build, Install, and Disposable Live Acceptance

**Files:**
- Create: `tests/end-to-end.test.ts`
- Create: `README.md`
- Create: `docs/acceptance-test.md`
- Modify: `package.json` only if final check commands need correction

**Interfaces:**
- Produces: complete mocked workflow proof, operator documentation, built plugin artifacts, installed local plugin, and bounded live-acceptance evidence.
- Consumes: every prior task.

- [ ] **Step 1: Write the failing end-to-end mocked workflow test**

The test must drive this exact sequence through public ingress/service boundaries:

```text
pair owner
enable project
submit task
select project
confirm
upload immutable work-order attachment
spawn implementation worktree/thread
implementation idle with PR
resolve authoritative remote head with git ls-remote
upload immutable review-packet attachment
spawn review child
review changes requested
send remediation to original implementation thread
new implementation head
spawn fresh review child
review pass
run deterministic validation
issue merge approval
serve stale gh head metadata while changing git refs/pull head before click and reject stale approval
fresh review and validation
issue new approval
race a second executor instance and fence it out
merge once
fail Telegram completion delivery
restart plugin services
deliver completion without a second merge
```

Assert tiny prompts plus out-of-worktree handoff attachments, visible spawned (not forked) threads, exact environment reuse, three separate review attempts where required, Git-native full-SHA binding despite stale `gh` metadata, one winning executor generation, one merge SDK call, and final `merged` state.

- [ ] **Step 2: Run the end-to-end test to verify RED, then repair only integration gaps**

Run: `npm test -- tests/end-to-end.test.ts`

Expected initial result: FAIL at the first missing or incorrectly wired public behavior. Make the smallest integration corrections in the owning modules; do not add a second orchestration path in the test.

- [ ] **Step 3: Run the end-to-end test to verify GREEN**

Run: `npm test -- tests/end-to-end.test.ts`

Expected: PASS with one merge call and durable completion recovery.

- [ ] **Step 4: Write operator README without secrets**

Document:

- prerequisites: BB 0.36+, GitHub CLI authenticated on each project host, standard GitHub-backed BB projects, Telegram bot created through BotFather;
- install/build: `npm install`, `npm run check`, `bb plugin install . --yes`;
- token entry only through Extensions → Plugins → Telegram Agent;
- `bb telegram-agent pair`, owner pairing, project policy JSON schema, and `doctor`;
- Telegram task/project/confirmation/status/review/approval flow;
- retry, cancel, review-cycle Continue, token rotation, unpair, restart recovery, logs, and uninstall;
- single-executor ownership, BB-thread versus worktree isolation, attachment-based handoffs, authoritative `git ls-remote` head binding, and honest stale/unknown liveness behavior;
- explicit warning that installation is full-trust code and merge still respects GitHub protection.

- [ ] **Step 5: Write the disposable live acceptance runbook**

`docs/acceptance-test.md` must list the twelve design-spec steps, evidence fields for Telegram message ids, handoff attachment names/digests, BB thread/environment ids, spawn-versus-fork proof, executor owner/generation, liveness source/state, PR number, both `git ls-remote` OIDs, deliberately stale `gh` head metadata, old/new head SHAs, review verdicts, validation commands, merge response, merge commit, plugin restart time, and final `bb plugin list` status. It must prohibit production application repositories and require a disposable repository or disposable test branch whose merge is safe.

- [ ] **Step 6: Run the complete automated gate**

Run:

```bash
bb plugin types --check .
npm run check
git diff --check
```

Expected: generated types current; TypeScript passes; all tests pass with zero unhandled errors; plugin build succeeds; no whitespace errors.

- [ ] **Step 7: Install the local plugin and verify BB registration**

Run:

```bash
bb plugin install . --yes
bb plugin list --json
bb plugin logs telegram-agent -n 50
```

Expected: plugin id `telegram-agent` is installed from this path. Before token entry, status is `needs-configuration` with the expected message; there is one `telegram-agent` CLI command and no crash-loop logs.

- [ ] **Step 8: Pause for owner-only secret configuration**

Ask the owner to enter the bot token in Extensions → Plugins → Telegram Agent. Do not request the token in chat and do not use `bb plugin config telegram-agent set botToken ...`, because that would expose it in command history and tool output.

- [ ] **Step 9: Run pairing, project doctor, and disposable live acceptance**

After the owner confirms token entry:

```bash
bb telegram-agent pair
bb telegram-agent project enable <disposable-project-id> --policy-file /absolute/path/to/policy.json
bb telegram-agent doctor <disposable-project-id>
```

Execute every step in `docs/acceptance-test.md`, including forced review remediation, `ls-remote` rejection when `gh` appears to match the stale verdict, fresh approval, a two-executor lease race, a stale-liveness alert with no replacement spawn, merge, and plugin restart recovery. Record ids and SHAs, never the bot token, pairing code, provider credentials, or raw private message content.

- [ ] **Step 10: Re-run final verification after live acceptance**

Run:

```bash
npm run check
bb plugin list --json
git status --short --branch
```

Expected: automated gate remains green; plugin services are running; repository contains only intended tracked changes.

- [ ] **Step 11: Commit the verified release candidate**

```bash
git add src tests/end-to-end.test.ts README.md docs/acceptance-test.md package.json package-lock.json
git commit -m "test: verify Telegram BB agent workflow"
```

- [ ] **Step 12: Hand off implementation evidence**

Report commit list, changed files, test/build counts, plugin installation/status, configured project alias without private path, disposable PR URL, attachment digests, executor fencing evidence, liveness evidence, Git-native stale-head rejection despite stale `gh` metadata, approved head SHA, merge result, restart-recovery result, and any external blocker. Do not claim live acceptance if the owner did not configure a bot token or disposable project.

---

## Final Requirements Traceability

| Approved requirement | Implemented and proved by |
|---|---|
| Single paired private-chat owner | Tasks 2, 5, 11, 12 |
| Long polling without public webhook | Tasks 4, 10, 12 |
| Per-task enabled project picker and confirmation | Tasks 2, 5, 12 |
| One active job | Tasks 2, 3, 5, 12 |
| Visible managed-worktree implementation thread | Tasks 6, 12 |
| Visible fresh spawned review child in same environment, never a provider-session fork | Tasks 6, 7, 12 |
| Immutable artifact handoff with tiny executor/reviewer prompts | Tasks 6, 12 |
| Exactly one generation-fenced execution engine; ingress never touches a worktree | Tasks 5, 10, 12 |
| BB-owned worker liveness with stale/unknown fail-closed behavior and no speculative restart | Tasks 8, 10, 12 |
| Three-cycle remediation and Continue/Stop | Tasks 3, 7, 11, 12 |
| Strict reviewer JSON and no prose-based merge | Tasks 7, 8, 12 |
| Deterministic commands, GitHub checks, clean worktree, and Git-native exact PR-head SHA | Tasks 8, 9, 12 |
| One-use expiring Telegram merge approval | Task 9 and Task 12 |
| Fresh gate evaluation and BB PR merge | Tasks 8, 9, 12 |
| No duplicate threads/messages/merge after restart | Tasks 3, 10, 12 |
| Safe cancellation without deleting work | Tasks 3, 10, 11, 12 |
| Full-trust, secret-safe operator workflow | Tasks 1, 2, 4, 11, 12 |
