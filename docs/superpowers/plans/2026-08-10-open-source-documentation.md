# Open-source Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the repository's operator-manual README with a concise public landing page and focused, verified documentation for operators and contributors.

**Architecture:** The README becomes a routing surface, not the complete manual. Public detail is split by responsibility into architecture, configuration, operations, and live acceptance documents, while existing Superpowers plans/specifications remain untouched as design history. Root contributor and security files cover repository governance without inventing a license or support promise.

**Tech Stack:** GitHub-flavored Markdown, Mermaid, TypeScript source-of-truth inspection, BB CLI, Git.

## Global Constraints

- Runtime code, tests, plugin settings, and package metadata do not change.
- No logo, screenshot, demo GIF, generated image, badge, CI workflow, release automation, package publication, or website is added.
- No license is selected or implied.
- No bot token, pairing secret, callback nonce, provider credential, private path, or raw Telegram transcript appears in documentation.
- All commands, settings, defaults, policy fields, pipeline stages, and safety claims are verified against current source or live CLI output.
- Existing `docs/superpowers/` content remains intact as design history.
- Mermaid diagrams remain small and describe only implemented ownership and stage relationships.

---

### Task 1: Public documentation map and architecture

**Files:**
- Create: `docs/README.md`
- Create: `docs/architecture.md`

**Interfaces:**
- Consumes: `src/plugin.ts`, `src/domain/pipeline-graph.ts`, `src/domain/state-machine.ts`, `src/controller/bb-controller.ts`, `src/controller/tools.ts`, and `src/services/*`.
- Produces: stable public links and the architectural vocabulary used by the README, configuration, and operations docs.

- [ ] **Step 1: Create the public docs index**

Write `docs/README.md` with exactly these primary routes:

```markdown
- [Architecture](architecture.md)
- [Configuration](configuration.md)
- [Operations](operations.md)
- [Disposable live acceptance](live-acceptance.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
```

Add one separate "Design history" paragraph that labels `superpowers/specs/` and `superpowers/plans/` as implementation records rather than operator instructions.

- [ ] **Step 2: Write the architecture document**

Use these sections: `System model`, `Ownership and data flow`, `Reviewed delivery pipeline`, `BB threads and worktrees`, `Durable state`, and `Safety properties`. Include one Mermaid flowchart for ownership and one for the pipeline. State explicitly that ingress only enqueues, the leased executor alone starts BB work, reviewer conversations are fresh, and worktrees remain the file/code boundary.

- [ ] **Step 3: Verify architecture claims mechanically**

Run:

```bash
rg -n 'background\.service|events\.on|new BbControllerAdapter|registerControllerTools' src/plugin.ts
sed -n '1,240p' src/domain/pipeline-graph.ts
rg -n 'findSpawnCandidate|threads\.spawn|threads\.send' src/controller src/bb
rg -n 'acquireExecutorLease|renewExecutorLease|worker_liveness|outbox' src/storage src/services
```

Expected: every ownership, stage, isolation, and durability statement has a matching implementation site.

- [ ] **Step 4: Commit the public architecture docs**

```bash
git add docs/README.md docs/architecture.md
git commit -m "docs: add public architecture guide"
```

---

### Task 2: Configuration and operations guides

**Files:**
- Create: `docs/configuration.md`
- Create: `docs/operations.md`

**Interfaces:**
- Consumes: `src/config.ts`, `src/controller/execution-profile.ts`, `src/domain/models.ts`, `src/cli.ts`, and the live `bb plugin config telegram-agent` output.
- Produces: operator instructions linked by the README and documentation index.

- [ ] **Step 1: Write configuration around real trust boundaries**

Use these sections: `Prerequisites`, `Install`, `Configure the Telegram bot`, `Pair one owner`, `Controller profile`, `Enable a project`, `Project policy reference`, and `Validate configuration`. Keep the complete policy example but use unmistakable placeholders such as `OWNER/REPOSITORY`, `PROVIDER_ID`, and `IMPLEMENTATION_MODEL`.

- [ ] **Step 2: Write operations around observable state**

Use these sections: `Health`, `Inspect jobs`, `Retry or cancel`, `Rotate the bot token`, `Unpair`, `Restart and recovery`, `Production failures`, and `Remove the plugin`. Document only command forms accepted by `src/cli.ts`; do not advertise `--help`, which the plugin CLI rejects.

- [ ] **Step 3: Verify commands, settings, and policy fields**

Run:

```bash
bb plugin config telegram-agent
bb telegram-agent doctor --json
rg -n 'PROJECT_ENABLE_FLAGS|JOB_LIST_FLAGS|JOB_ID_FLAGS|DOCTOR_FLAGS' src/cli.ts
sed -n '1,120p' src/domain/models.ts
sed -n '1,100p' src/controller/execution-profile.ts
```

Expected: every documented key/default/option/flag exists; the bot token is shown only as `[set]` in live output.

- [ ] **Step 4: Commit the operator guides**

```bash
git add docs/configuration.md docs/operations.md
git commit -m "docs: add configuration and operations guides"
```

---

### Task 3: Public README and repository governance

**Files:**
- Rewrite: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`

**Interfaces:**
- Consumes: public documents from Tasks 1–2 and package scripts from `package.json`.
- Produces: the GitHub repository landing page and contributor/security entry points.

- [ ] **Step 1: Rewrite the README as a landing page**

Use this order: title/tagline, Valor attribution, `Why Telegram Agent?`, `How it works`, `Pipeline`, warning, `Quick start`, `Documentation`, `Repository layout`, `Development`, and `Project status`. Limit the README to the minimum installation commands and link deep configuration/operations content instead of repeating it.

- [ ] **Step 2: Add contributor guidance**

Document Node/npm/BB prerequisites, `npm ci`, `npm run check`, `bb plugin types --check .`, focused Vitest usage, docs verification, secret rules, scope discipline, and the expected pull-request evidence. Do not claim a code of conduct, CLA, issue template, or CI gate exists.

- [ ] **Step 3: Add security guidance**

State that vulnerabilities and credential exposure must not be filed publicly; use private maintainer contact or GitHub private vulnerability reporting when available. Define the trust model, credential handling, high-impact operations, and the fact that only the current `0.1.x` development line exists without promising a support window.

- [ ] **Step 4: Verify README and governance claims**

Run:

```bash
node -e 'const p=require("./package.json"); console.log(p.engines, p.scripts)'
test ! -e LICENSE
rg -n 'TODO|TBD|coming soon|production.ready|official|supported versions' README.md CONTRIBUTING.md SECURITY.md
```

Expected: package requirements/scripts match the docs, no license exists, and no placeholder or unsupported maturity claim is present.

- [ ] **Step 5: Commit the landing page and governance docs**

```bash
git add README.md CONTRIBUTING.md SECURITY.md
git commit -m "docs: prepare repository for public contributors"
```

---

### Task 4: Live acceptance cleanup and documentation gate

**Files:**
- Move: `docs/acceptance-test.md` → `docs/live-acceptance.md`
- Modify: `docs/live-acceptance.md`
- Modify: `docs/README.md`, `README.md` only if the final move reveals a broken link.

**Interfaces:**
- Consumes: the existing disposable acceptance evidence requirements and current configurable controller profile.
- Produces: a public runbook with no internal task numbering or stale fixed-Luna assumption.

- [ ] **Step 1: Rename and clean the acceptance runbook**

Use `git mv`. Replace "Task 12" with "automated test suite", make the controller tuple an evidence field populated from current settings, rename "Verify the Luna conversation" and "Submit a bounded task through Luna" to controller-neutral headings, and retain the disposable-repository and secret-redaction boundaries.

- [ ] **Step 2: Check every relative Markdown link**

Run this repository-local Node check:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...fs.readdirSync('docs').filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
const missing = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) missing.push(`${file}: ${target}`);
  }
}
if (missing.length) { console.error(missing.join('\n')); process.exit(1); }
NODE
```

Expected: exit 0 with no output.

- [ ] **Step 3: Run Docs Guard and the full repository gate**

Verify every claim against the source, then run:

```bash
git diff --check
npm run check
bb plugin types --check .
```

Expected: all commands exit 0; Vitest reports zero failures; the plugin build and SDK type check succeed.

- [ ] **Step 4: Confirm docs-only scope and commit**

```bash
git status --short
git diff --name-only a77e498..HEAD
git add -A docs/acceptance-test.md docs/live-acceptance.md docs/README.md README.md
git commit -m "docs: publish open-source documentation set"
```

Expected: only Markdown documentation and the acceptance-runbook rename are present across the documentation implementation commits.
