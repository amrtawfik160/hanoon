# README Diagrams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two polished, accurate SVG diagrams to the public README using Valor's checked-in-asset presentation pattern.

**Architecture:** The README embeds two self-contained SVG files stored under `docs/assets/`. The system diagram communicates ownership boundaries; the pipeline diagram communicates stage order and bounded failure loops. Existing Mermaid diagrams remain the detailed maintainer-facing source maps.

**Tech Stack:** SVG 1.1-compatible XML, GitHub-flavored Markdown, Node.js link/XML validation, Git.

## Global Constraints

- Do not modify runtime code, tests, plugin settings, package metadata, or unrelated dirty files.
- Diagram labels and edges must match the current implementation.
- SVGs must contain no scripts, remote resources, embedded secrets, or private paths.
- README images must use relative paths and descriptive alternative text.
- The assets must remain readable on GitHub without external fonts.

---

### Task 1: Add the system architecture diagram

**Files:**
- Create: `docs/assets/architecture.svg`
- Modify: `README.md`

**Interfaces:**
- Consumes: the ownership model documented in `docs/architecture.md` and implemented in `src/plugin.ts`, `src/services/`, and `src/bb/runner.ts`.
- Produces: a centered README architecture image with an accessible description.

- [ ] **Step 1: Draw the ownership layers**

Create a self-contained SVG with Telegram, I/O bridge, SQLite control plane, sole executor, BB threads, and worktree cards. Label session-spawning and filesystem boundaries explicitly.

- [ ] **Step 2: Embed the asset**

Add an `Architecture` section to `README.md` using a centered HTML image with `src="docs/assets/architecture.svg"`, descriptive alternative text, and a bounded width.

- [ ] **Step 3: Render and inspect**

Parse the SVG as XML, render a local PNG preview, and inspect text clipping, connector direction, spacing, and contrast.

---

### Task 2: Add the reviewed pipeline diagram

**Files:**
- Create: `docs/assets/reviewed-pipeline.svg`
- Modify: `README.md`

**Interfaces:**
- Consumes: stage and failure edges from `src/domain/pipeline-graph.ts`.
- Produces: a centered README pipeline image that distinguishes design, delivery, release, remediation, and blocked states.

- [ ] **Step 1: Draw the happy path**

Create the three-lane stage graph from intake through complete, with owner approval before merge and deploy/canary after merge.

- [ ] **Step 2: Draw bounded loops**

Add critique-to-plan, validation/review-to-patch, patch-to-test, and exhausted-evidence-to-blocked edges without obscuring the main path.

- [ ] **Step 3: Replace the text-only pipeline**

Embed the SVG in `README.md` and retain the existing explanatory paragraph about bounded remediation and fail-closed behavior.

- [ ] **Step 4: Render and inspect**

Parse and render the SVG, then inspect every stage label and arrow at the intended README width.

---

### Task 3: Documentation and repository gate

**Files:**
- Verify: `README.md`
- Verify: `docs/assets/architecture.svg`
- Verify: `docs/assets/reviewed-pipeline.svg`

**Interfaces:**
- Consumes: completed assets and README embeds.
- Produces: a docs-only commit with verified links, visuals, and repository health.

- [ ] **Step 1: Run documentation checks**

Parse SVG XML, validate relative links and images, scan for placeholders, and run `git diff --check`.

- [ ] **Step 2: Run the plugin gate**

Run `npm run check` and `bb plugin types --check .`.

- [ ] **Step 3: Confirm scope and commit**

Inspect the staged paths and commit only the README diagram work. Leave the unrelated runtime and test modifications unstaged.
