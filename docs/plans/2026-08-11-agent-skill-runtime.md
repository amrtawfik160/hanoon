# Agent Skill Runtime Implementation Plan

> Execution requirement: implement this plan with test-driven development, one task at a time, and request a review after the final verification gate.

**Goal:** Ship a self-contained, integrity-checked development skill bundle and select the smallest correct skill set for each verified plugin-owned worker role without changing durable job progression.

**Architecture:** The plugin manifest exposes two local skill roots: a pinned MIT-licensed workflow kit and three project-owned quality guards. A pure resolver maps a structurally verified worker thread plus durable attempt evidence to a fixed role profile. The existing single `bb.agents.configure` callback remains the only configuration hook: the exact hidden controller keeps its tools and no development skills, verified workers receive only their role profile, and every unrelated or inconsistent context receives nothing.

**Technology:** TypeScript, BB plugin SDK `bb.agents.configure`, Vitest, Node.js SHA-256 integrity scripts, committed Markdown skills, JSON lock metadata.

## Scope and invariants

- This slice bundles and routes skills only. It does not add skill receipts, alter state-machine transitions, change retry behavior, or grant merge/deploy authority.
- The controller receives `CONTROLLER_TOOL_NAMES`, `CONTROLLER_INSTRUCTIONS`, and zero development skills exactly as it does now.
- Worker selection is synchronous and fail-closed. It requires plugin origin, a standard project, a managed worktree, an anchored title, an existing durable attempt with matching job/attempt/role, and either an unbound thread id or the exact bound thread id.
- Planner and critic profiles intentionally select no generic skills. Validation, merge, deploy, and canary remain deterministic and receive none.
- The plugin has no runtime dependency on a separately installed skill plugin and performs no runtime download.
- The committed workflow kit is pinned to version `6.2.0` and retains its MIT license. The quality guards are independently written for this repository; do not copy unlicensed local guard files.
- Do not add `.superpowers/` or `docs/superpowers/`, do not add internal task reports, do not include the prohibited comparison-agent identifier, and do not push.
- Run focused tests during development. Run the complete suite once, at the final gate, because the configuration callback affects every provider session.

## Role contract

Use these exact plugin skill ids and no implicit aliases:

| Verified role | Skills |
| --- | --- |
| controller | none |
| planner | none |
| critic | none |
| implementation/remediation | `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `clean-code-guard`, `test-guard` |
| review | `clean-code-guard`, `test-guard` |
| documentation | `docs-guard`, `verification-before-completion` |
| final review | `clean-code-guard`, `test-guard`, `docs-guard` |

Thread titles remain the existing stable protocol:

```text
Telegram <jobId> implementation <attemptId>
Telegram <jobId> plan <attemptId>
Telegram <jobId> critique <attemptId>
Telegram <jobId> docs <attemptId>
Telegram <jobId> review <attemptId>
Telegram <jobId> final-review <attemptId>
```

The title parser must be anchored and match the production identifier contracts. Job ids accept 1–256 characters from `[A-Za-z0-9_-]`. Attempt ids accept 1–264 characters from `[A-Za-z0-9_.:-]`, covering the generated `attempt:<effect-key>` and `stage:<effect-key>` forms while rejecting whitespace, path separators, prefixes, suffixes, and unknown roles.

## Task 1: Vendor and verify the complete skill bundle

**Files:**

- Modify: `package.json`
- Modify: `server.ts`
- Create: `scripts/sync-workflow-skills.mjs`
- Create: `scripts/verify-skill-bundle.mjs`
- Create: `src/agent-skills/bundle-integrity.js`
- Create: `src/agent-skills/bundle-integrity.d.ts`
- Create: `skills/skills.lock.json`
- Create: `skills/workflow-kit/LICENSE`
- Create: `skills/workflow-kit/brainstorming/**`
- Create: `skills/workflow-kit/dispatching-parallel-agents/**`
- Create: `skills/workflow-kit/executing-plans/**`
- Create: `skills/workflow-kit/finishing-a-development-branch/**`
- Create: `skills/workflow-kit/receiving-code-review/**`
- Create: `skills/workflow-kit/requesting-code-review/**`
- Create: `skills/workflow-kit/subagent-driven-development/**`
- Create: `skills/workflow-kit/systematic-debugging/**`
- Create: `skills/workflow-kit/test-driven-development/**`
- Create: `skills/workflow-kit/using-git-worktrees/**`
- Create: `skills/workflow-kit/using-superpowers/**`
- Create: `skills/workflow-kit/verification-before-completion/**`
- Create: `skills/workflow-kit/writing-plans/**`
- Create: `skills/workflow-kit/writing-skills/**`
- Create: `skills/guards/clean-code-guard/SKILL.md`
- Create: `skills/guards/test-guard/SKILL.md`
- Create: `skills/guards/docs-guard/SKILL.md`
- Test: `tests/skill-bundle.test.ts`
- Test: `tests/skill-bundle-activation.test.ts`

### Step 1: Write the failing bundle contract test

Create `tests/skill-bundle.test.ts`. Read `package.json`, both committed skill roots, and `skills/skills.lock.json` from the repository root. Cover all of these assertions in data-driven tests:

- `bb.skills` is exactly `["skills/workflow-kit", "skills/guards"]`.
- Every immediate child registered as a skill contains `SKILL.md` with a bounded YAML frontmatter `name`.
- The three guard ids and all 14 workflow-kit ids occur exactly once.
- The catalog contains exactly the 14 workflow-kit ids and three guard ids listed in this task.
- Every locked file exists and its SHA-256 matches.
- Every file beneath the two roots is locked; there are no untracked-by-lock bundle files.
- The workflow-kit lock entry identifies version `6.2.0`, source URL `https://github.com/obra/superpowers`, license `MIT`, and `skills/workflow-kit/LICENSE`.
- Guard entries identify their source as `project-owned` and license as `repository`.

Run:

```bash
npx vitest run tests/skill-bundle.test.ts
```

Expected RED: the manifest contains no roots and the lock and skill directories do not exist.

### Step 2: Implement the deterministic synchronizer

Create `scripts/sync-workflow-skills.mjs` as a maintainer-only command. It must:

1. accept `--source <absolute-directory>` and `--version <semver>`;
2. require `<source>/LICENSE` and `<source>/skills`;
3. require the exact reviewed version `6.2.0` and verify it against the source package metadata;
4. copy only `LICENSE` and the full contents of `skills/`, excluding `.git`, generated output, caches, and operating-system metadata;
5. preserve relative resource paths used by each `SKILL.md`;
6. scan frontmatter names, reject duplicates or invalid names, sort paths lexically, hash file bytes with SHA-256, and rewrite `skills/skills.lock.json` deterministically;
7. never access the network and never mutate files outside `skills/workflow-kit` and `skills/skills.lock.json`.

The implementation invocation is:

```bash
WORKFLOW_KIT_SOURCE=/absolute/path/to/superpowers-6.2.0
npm run skills:sync -- --source "$WORKFLOW_KIT_SOURCE" --version 6.2.0
```

`WORKFLOW_KIT_SOURCE` is a maintainer-supplied checkout or installed package directory for the pinned release; it is not persisted by the command.

Inspect the staged tree after synchronization. It must contain the 14 listed skill directories and nested resources, not the upstream repository metadata, hooks, tests, or plugin manifests.

### Step 3: Write the three project-owned guards

Create the three guard `SKILL.md` files with exact frontmatter names matching their directories. Write them independently from the approved design and repository behavior.

Each guard must state:

- it reviews only the files/evidence in the enclosing worker contract;
- it does not authorize state transitions, approval, merge, deploy, push, or destructive cleanup;
- it follows the enclosing stage's output format, especially strict JSON review packets;
- when no enclosing output format exists, findings are bounded and include severity, file, line when known, evidence, and the smallest corrective action;
- it reports `passed` only after inspecting the relevant changed material and fresh verification evidence.

Guard-specific rules:

- `clean-code-guard`: correctness first, then Clean Code/SOLID/DRY/KISS/YAGNI, with special checks for duplicate orchestration, hidden state, callback-bearing persistence, swallowed errors, and needless compatibility branches.
- `test-guard`: prove the changed production path, observe RED before GREEN for behavioral changes, assert durable side effects and absence of forbidden effects, keep mocks at external boundaries, and reject tests that restate implementation logic.
- `docs-guard`: verify names, commands, defaults, links, and examples against current source; preserve the established docs structure; exclude secrets, transient task reports, internal planning paths, and claims unsupported by runnable evidence.

Rerun the synchronizer after creating the guards. It must leave `skills/guards` unchanged, scan both registered roots, and add the project-owned guard records and digests to the same deterministic lock.

### Step 4: Add the shared activation integrity checker

Create the reusable verifier in `src/agent-skills/bundle-integrity.js` with its exact public types in the adjacent `bundle-integrity.d.ts`, exporting:

```ts
export function resolvePluginRoot(moduleUrl: string): string;
export function verifySkillBundle(pluginRoot: string): Readonly<{
  bundleDigest: string;
  skillIds: readonly string[];
}>;
```

`resolvePluginRoot` must accept both source execution (`server.ts` in the plugin root) and built execution (`dist/server.js`) by selecting the nearest directory whose `package.json` has name `bb-plugin-telegram-agent`. It must not use the process working directory.

Create `scripts/verify-skill-bundle.mjs` as a thin Node entry point that imports the shared verifier, resolves the repository root relative to its own module URL, calls it, and prints only the bounded bundle digest and skill count on success. It accepts no mutation flags and exits non-zero with a precise path/reason when:

- lock JSON is malformed or has an unsupported schema version;
- a root, skill file, license, or referenced nested resource is missing;
- a digest differs;
- an unlocked file exists below a registered root;
- a locked file escapes `skills/`;
- a frontmatter name is missing, duplicated, or differs from its lock record.

Use synchronous bounded reads during plugin activation. Reject symbolic links, files larger than 256 KiB, lock files larger than 1 MiB, more than 64 skills, or more than 512 locked files before hashing.
For nested-resource validation, inspect relative Markdown links in each `SKILL.md` after removing fenced code blocks. Ignore `http:`, `https:`, `mailto:`, and fragment-only targets; strip fragments from local targets, reject paths that escape the containing skill directory, and require the resolved file to exist. Do not treat illustrative filenames in prose or fenced examples as references.

Add scripts:

```json
{
  "skills:sync": "node scripts/sync-workflow-skills.mjs",
  "skills:verify": "node scripts/verify-skill-bundle.mjs"
}
```

Change `bb.skills` to the two exact roots. Do not add an npm runtime dependency.
Also change `build` to `npm run skills:verify && bb plugin build`. The existing `check` script already calls `build`, so both direct builds and the normal project gate reject a corrupt bundle without running the verifier twice.

### Step 5: Fail plugin activation before registration when integrity is invalid

Modify `server.ts` to export a testable activation function and keep the default BB entrypoint:

```ts
export function activatePlugin(bb: BbPluginApi, pluginRoot: string): Promise<void> {
  verifySkillBundle(pluginRoot);
  return createPlugin(bb);
}

export default function plugin(bb: BbPluginApi): Promise<void> {
  return activatePlugin(bb, resolvePluginRoot(import.meta.url));
}
```

Create `tests/skill-bundle-activation.test.ts`. Copy `package.json`, `skills/`, and the required directory shape into a temporary root, corrupt one locked skill byte, and call `activatePlugin` with that root and a fake BB host. Assert it throws the exact digest error before settings, tools, services, schedules, or CLI commands are registered. A second test calls `verifySkillBundle` against the real repository root and asserts the bounded skill count and digest shape.

### Step 6: Verify Task 1

Run:

```bash
npm run skills:verify
npx vitest run tests/skill-bundle.test.ts tests/skill-bundle-activation.test.ts
git diff --check
```

Expected GREEN: the checker exits zero and the focused test passes. Copy the bundle into a temporary directory, mutate one copied byte, prove the checker fails on the exact path, and discard the temporary directory; never mutate the tracked bundle for this test.

### Step 7: Commit Task 1

```bash
git add package.json server.ts scripts src/agent-skills/bundle-integrity.js src/agent-skills/bundle-integrity.d.ts skills tests/skill-bundle.test.ts tests/skill-bundle-activation.test.ts
git diff --cached --check
git commit -m "feat: bundle agent workflow skills"
```

## Task 2: Add a pure, fail-closed worker role resolver

**Files:**

- Create: `src/agent-skills/role-resolver.ts`
- Test: `tests/agent-skill-routing.test.ts`
- Modify: `tests/skill-bundle.test.ts`

### Step 1: Write the failing role-table and parser tests

Create `tests/agent-skill-routing.test.ts` and import the public resolver surface:

```ts
export type WorkerSkillRole =
  | "planner"
  | "critic"
  | "implementation"
  | "review"
  | "documentation"
  | "final-review";

export type WorkerTitleIdentity = Readonly<{
  jobId: string;
  attemptId: string;
  role: WorkerSkillRole;
}>;

export type DurableWorkerIdentity = WorkerTitleIdentity & Readonly<{
  projectId: string;
  environmentId: string | null;
  threadId: string | null;
}>;

export type WorkerSkillProfile = Readonly<{
  role: WorkerSkillRole;
  skills: readonly BundledSkillId[];
  instructions: string;
}>;

export function parseWorkerThreadTitle(title: string | null): WorkerTitleIdentity | null;

export function resolveWorkerSkillProfile(input: Readonly<{
  context: PluginAgentConfigurationContext;
  pluginId: string;
  durableIdentity: DurableWorkerIdentity | null;
}>): WorkerSkillProfile | null;
```

Test the exact role table from this plan. Then use a data table to prove rejection for:

- null title, unknown role, spaces or path separators inside ids, over-limit ids, and prefix/suffix text;
- wrong or null origin plugin id and `origin.kind === "fork"`;
- personal project, unmanaged workspace, or personal workspace;
- missing durable identity;
- mismatched job id, attempt id, role, exact project id, or persisted environment id;
- a durable thread id different from `context.thread.id`.

Add positive parser/build round trips for `attempt:<job>:<version>:spawn_implementation`, `attempt:<job>:<version>:spawn_review`, `attempt:<job>:<version>:spawn_final_review`, `stage:<job>:<version>:spawn_plan`, `stage:<job>:<version>:spawn_critique`, and `stage:<job>:<version>:spawn_docs`. These examples must come from the same id-construction rules used in `src/services/effect-runner.ts`, not underscore-only fixtures.

Prove both allowed ownership cases: `durableIdentity.threadId === null` for the first thread start and exact equality after persistence. Apply the same rule to `environmentId`: null permits first worktree creation, while a persisted id must equal `context.environment.id`.

Run:

```bash
npx vitest run tests/agent-skill-routing.test.ts
```

Expected RED: the module does not exist.

### Step 2: Implement the smallest typed resolver

Create `src/agent-skills/role-resolver.ts` with:

- `BUNDLED_SKILL_IDS` as a readonly tuple containing the six selected ids from the role table;
- `BundledSkillId` derived from that tuple;
- `ROLE_SKILLS` as a readonly exhaustive record;
- one anchored title regex and one explicit token-to-role switch;
- `buildWorkerInstructions(profile)` producing at most 1,200 characters;
- `parseWorkerThreadTitle` and `resolveWorkerSkillProfile` exactly as tested.

Worker dynamic instructions must say only:

1. the verified role;
2. the exact selected skill ids, or that none are selected;
3. the immutable attached work order/review packet and durable project policy outrank skill suggestions;
4. skills cannot authorize approval, merge, deploy, push, or state changes;
5. the worker must obey the packet's response contract.

Do not put job request text, file paths, owner messages, or mutable provider output into dynamic instructions.

### Step 3: Cross-check the role table against the manifest

Extend `tests/skill-bundle.test.ts` to flatten `ROLE_SKILLS` and prove every selected id exists in the registered manifest catalog. Prove the implementation list has no duplicates and the empty planner/critic lists remain intentional.

### Step 4: Verify and commit Task 2

Run:

```bash
npx vitest run tests/agent-skill-routing.test.ts tests/skill-bundle.test.ts
npm run typecheck
git diff --check
```

Commit:

```bash
git add src/agent-skills/role-resolver.ts tests/agent-skill-routing.test.ts tests/skill-bundle.test.ts
git diff --cached --check
git commit -m "feat: define worker skill profiles"
```

## Task 3: Bind durable attempt identity to the single configuration hook

**Files:**

- Modify: `src/controller/tools.ts`
- Test: `tests/controller-tools.test.ts`

### Step 1: Write failing integration tests through the BB fake host

Update the `controller-tools` fixture to construct the fake host with:

```ts
createFakePluginHost({
  pluginId,
  agentSkillIds: [...BUNDLED_SKILL_IDS],
});
```

Keep the existing controller assertions and add these cases through `harness.behavior.resolveAgentConfiguration(context)`:

1. exact controller: all controller tools, zero skills, unchanged controller instructions;
2. implementation attempt with a production-shaped `attempt:<effect-key>` id, its exact `spawn_implementation` effect, and a matching unbound thread: implementation skill set, zero plugin tools;
3. same attempt after its thread id is persisted: same skill set;
4. review and final-review titles backed by `review` attempts and exact `spawn_review` or `spawn_final_review` effects: their distinct exact sets;
5. PLAN, CRITIQUE, and DOCS `stage:<effect-key>` rows backed by exact `spawn_plan`, `spawn_critique`, or `spawn_docs` effects: empty, empty, and documentation sets;
6. title role inconsistent with stored attempt kind, pipeline role, or originating effect kind: no tools, no skills, no instructions;
7. missing attempt, mismatched thread id, wrong job id, wrong project/workspace/origin, and fork: fail closed;
8. a spoofed controller title that is not the exact stored controller: fail closed.

For the first-start cases, create the attempt row before resolving configuration, leaving its `thread_id` null. For resumed cases, use the fenced store update path to persist the exact thread id rather than rewriting SQLite directly.

Run:

```bash
npx vitest run tests/controller-tools.test.ts
```

Expected RED: verified workers resolve no skills.

### Step 2: Add a synchronous durable identity adapter

In `src/controller/tools.ts`, add a private helper that receives the parsed `WorkerTitleIdentity` plus the configuration context and reads exactly one matching durable record:

- `implementation`, `review`, and `final-review` use `store.getAttempt(attemptId)` and require the same `jobId`; implementation requires kind `implementation`, while both review roles require kind `review`;
- `planner`, `critic`, and `documentation` use `store.getPipelineStageAttempt(attemptId)` and require role `PLAN`, `CRITIQUE`, or `DOCS` respectively plus the same `jobId`;
- require `attempt:` for ordinary attempts and `stage:` for pipeline attempts, strip only that exact prefix, and call `store.getEffect(jobId, effectIdempotencyKey)`;
- require the originating effect kind to agree exactly: `spawn_implementation`, `spawn_review`, `spawn_final_review`, `spawn_plan`, `spawn_critique`, or `spawn_docs`; this is the durable distinction between initial and final review;
- load the exact job with `store.getJob(jobId)`, require its selected `projectId` to equal `context.project.id`, and include its persisted `environmentId` in the resolver evidence;
- return the record's persisted `threadId`, including null for the safe first-start case;
- return null on every mismatch; do not fall back to newest job, active job, title alone, or parent-thread inference.

Keep this lookup bounded and synchronous. Do not add a new storage query or migration.

### Step 3: Extend the existing configure callback, do not register a second one

Preserve the exact controller branch first. If it does not match:

1. parse the worker title;
2. resolve durable identity from the exact attempt id;
3. call `resolveWorkerSkillProfile`;
4. return `{ tools: [], skills: [...profile.skills], instructions: profile.instructions }` only for a verified profile;
5. otherwise return `{ tools: [], skills: [] }`.

The callback must not throw for ordinary unrecognized contexts. It must never expose controller tools to a worker and never expose worker skills to the controller.

### Step 4: Verify and commit Task 3

Run:

```bash
npx vitest run tests/controller-tools.test.ts tests/agent-skill-routing.test.ts
npm run typecheck
git diff --check
```

Commit:

```bash
git add src/controller/tools.ts tests/controller-tools.test.ts
git diff --cached --check
git commit -m "feat: route skills by durable worker role"
```

## Task 4: Align worker prompts with the selected skill contract

**Files:**

- Modify: `src/bb/prompts.ts`
- Modify: `src/bb/runner.ts`
- Modify: `src/services/effect-runner.ts`
- Test: `tests/prompts.test.ts`
- Test: `tests/bb-runner.test.ts`
- Test: `tests/pipeline-stage-runner.test.ts`
- Test: `tests/effect-runner.test.ts`

### Step 1: Write failing prompt and title round-trip tests

Add tests proving:

- every title emitted by the six worker spawn paths round-trips through `parseWorkerThreadTitle` to the correct job id, production-shaped attempt id, and role;
- crash-recovery candidate lookup in `EffectRunner` uses the same title bytes for ordinary and pipeline attempts;
- implementation and review prompts remain attachment-first and do not duplicate full skill contents;
- the docs prompt names only the actually selected `docs-guard` and `verification-before-completion` ids;
- no prompt claims that an unavailable plugin skill is selected;
- the dynamic worker instructions and immutable packet have one authority rule: the packet and durable policy win over skill suggestions;
- strict JSON review and critique output wording remains unchanged.

Run:

```bash
npx vitest run tests/prompts.test.ts tests/bb-runner.test.ts tests/pipeline-stage-runner.test.ts tests/effect-runner.test.ts
```

Expected RED: the docs prompt still names an unselected skill and title round-trip helpers are not asserted.

### Step 2: Centralize title construction without changing title bytes

Export:

```ts
export function buildWorkerThreadTitle(identity: WorkerTitleIdentity): string;
```

from `src/agent-skills/role-resolver.ts`. Replace the six interpolated title expressions in `src/bb/runner.ts` and both crash-recovery title expressions in `src/services/effect-runner.ts` with this helper. Map `PLAN`, `CRITIQUE`, and `DOCS` to planner, critic, and documentation before calling it. Preserve every existing title byte so durable records and recovery remain compatible.

### Step 3: Correct only the skill-related prompt text

Replace the docs prompt's advisory skill labels with the exact selected ids. Keep its existing immutable attachments, environment reuse, stage output requirements, and current workflow actions. Do not broaden the worker's tools or change when documentation runs.

Keep implementation/review prompts short. Role and skill selection belongs in `bb.agents.configure`; do not paste the skill bodies into prompts.

### Step 4: Verify and commit Task 4

Run:

```bash
npx vitest run tests/prompts.test.ts tests/bb-runner.test.ts tests/pipeline-stage-runner.test.ts tests/effect-runner.test.ts tests/controller-tools.test.ts
npm run skills:verify
npm run typecheck
git diff --check
```

Commit:

```bash
git add src/agent-skills/role-resolver.ts src/bb/prompts.ts src/bb/runner.ts src/services/effect-runner.ts tests/prompts.test.ts tests/bb-runner.test.ts tests/pipeline-stage-runner.test.ts tests/effect-runner.test.ts
git diff --cached --check
git commit -m "refactor: align worker prompts with skill profiles"
```

## Task 5: Document, guard-review, and activate the runtime

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `docs/live-acceptance.md`

### Step 1: Update user and operator documentation

Document:

- skills are bundled locally and require no extra plugin installation;
- the exact role table and fail-closed structural checks;
- `npm run skills:verify` and the maintainer-only pinned synchronization command;
- integrity failure means activation/build must stop, not download a replacement;
- role-specific real-provider observation is required in the later executable acceptance slice and is not replaced by this deterministic gate.

In `docs/live-acceptance.md`, add a pending evidence row for each non-empty role profile. The row must require real thread id, role, selected ids, bundle digest, and provider-session outcome. Do not mark those rows passed during this slice because persistent skill receipts do not exist yet.

### Step 2: Run the three guard reviews on the complete diff

Apply the newly bundled guards to the staged change:

- `clean-code-guard`: inspect production TypeScript and integrity scripts;
- `test-guard`: inspect the tests for real resolver/configuration behavior, mutation sensitivity, and absence of implementation duplication;
- `docs-guard`: verify commands, ids, role tables, license/version claims, links, and exclusions against the committed files.

Fix every Critical/Important finding. Record only bounded findings in the implementation report; do not create a tracked internal report.

Apply each fix to the task that owns the affected file and rerun that task's focused gate. If a guard fix changes production or test files after their task commit, stage only the exact paths printed by `git diff --name-only`, commit them as `fix: address skill runtime guard findings`, and keep the documentation commit separate.

### Step 3: Run one final deterministic gate

Run exactly once after all fixes:

```bash
npm run skills:verify
npx vitest run tests/skill-bundle.test.ts tests/skill-bundle-activation.test.ts tests/agent-skill-routing.test.ts tests/controller-tools.test.ts tests/prompts.test.ts tests/bb-runner.test.ts tests/pipeline-stage-runner.test.ts tests/effect-runner.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

This is not a smoke gate: the focused set exercises real manifest files, real skill bytes/digests, the production configuration callback through the SDK host, real SQLite attempt ownership, and every worker spawn title. The complete suite runs once to catch callback regressions outside the focused surface.

### Step 4: Enforce repository hygiene before activation

Run:

```bash
git status --short
git ls-files | rg '(^|/)(\.superpowers|docs/superpowers)(/|$)' && exit 1 || true
forbidden_name=$(printf '\126\141\154\157\162')
git grep -n -i "$forbidden_name" -- . && exit 1 || true
```

Do not echo `forbidden_name`. Confirm the only vendored attribution is the requested workflow kit and its license.

### Step 5: Build, install, enable, and reload the actual plugin

After the gates pass:

```bash
if ! bb plugin source telegram-agent >/dev/null 2>&1; then
  bb plugin install . --yes
fi
bb plugin source telegram-agent | rg -F "resolved: path:$(pwd)"
bb plugin enable telegram-agent
bb plugin reload telegram-agent
bb plugin list --json
bb plugin logs telegram-agent -n 100
```

Require the installed plugin to report running with no manifest-skill, duplicate-name, digest, or activation errors. This proves the actual BB build and plugin activation path accepts the committed bundle; it does not claim live provider skill use.

### Step 6: Commit the documentation and activation-ready state

```bash
git add README.md docs/architecture.md docs/operations.md docs/live-acceptance.md
git diff --cached --check
git status --short
git commit -m "docs: operate the bundled skill runtime"
```

Do not push. The next separately approved slice persists skill receipts and runs the real Telegram/provider role observations required by the acceptance design.

## Completion evidence

Before claiming this plan complete, report:

- all commit hashes created by the tasks;
- focused and complete test counts;
- typecheck, build, and `skills:verify` exit status;
- installed plugin id and running status;
- exact manifest skill count and role-selection matrix;
- guard-review verdicts;
- clean tracked worktree and hygiene scan results;
- explicit statement that live provider skill-use evidence remains pending for the receipt/acceptance slice.
