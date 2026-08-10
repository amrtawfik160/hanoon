# Public README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the long operational README with a concise public landing page, two GPT Image 2 diagrams, and focused detailed documentation without changing plugin behavior.

**Architecture:** Preserve the existing documentation claims while moving policy, operations, and trust-boundary detail into three single-purpose files under `docs/`. Generate two landscape PNG diagrams through the bundled explicit `gpt-image-2` CLI path, inspect them, then integrate them into a short README modeled on the information hierarchy—not the language or branding—of Valor's README.

**Tech Stack:** Markdown, GPT Image 2 Image API CLI, PNG assets, BB plugin CLI, TypeScript/Vitest verification.

## Global Constraints

- Documentation and generated documentation assets only; do not modify plugin source, tests, settings, storage, packaging, or live services.
- Preserve every current operational, policy, recovery, and safety guarantee in either the README or a linked detailed document.
- Use explicit model `gpt-image-2`, quality `high`, size `2048x1152`, PNG output, and no transparent background.
- Generated labels must be readable and must not add capabilities, actors, services, or guarantees absent from the current plugin.
- The README must remain useful without the images through accurate alt text and surrounding prose.
- Verify every command, flag, config key, default, path, and behavioral claim against current source or runnable CLI.
- Do not copy Valor's prose, name, branding, or diagrams.

---

### Task 1: Generate and validate the system diagrams

**Files:**
- Create: `docs/assets/telegram-agent-architecture.png`
- Create: `docs/assets/guarded-delivery-loop.png`
- Temporary: `output/imagegen/telegram-agent-architecture.png`
- Temporary: `output/imagegen/guarded-delivery-loop.png`

**Interfaces:**
- Consumes: the approved diagram requirements in `docs/superpowers/specs/2026-08-10-readme-information-architecture-design.md`.
- Produces: two inspected 2048x1152 PNG assets referenced by the README.

- [ ] **Step 1: Confirm the explicit model path is available**

Run without printing the credential:

```bash
test -n "$OPENAI_API_KEY"
python -c 'import openai; print(openai.__version__)'
```

Expected: both commands exit 0. If the key or dependency is missing, stop and report the exact prerequisite without exposing a secret.

- [ ] **Step 2: Dry-run the architecture prompt**

Run:

```bash
python /root/.codex/skills/.system/imagegen/scripts/image_gen.py generate \
  --model gpt-image-2 \
  --quality high \
  --size 2048x1152 \
  --output-format png \
  --use-case infographic-diagram \
  --prompt "System architecture for Telegram Agent, a BB plugin. Show the exact left-to-right flow Telegram owner to Durable ingress to SQLite job state to Leased executor. From the executor branch to Luna Max controller inside Hidden BB thread and Personal workspace; Implementation inside Visible BB thread and Managed worktree; Fresh review child with an independent provider conversation that reuses the managed worktree; then GitHub PR. Make two boundaries explicit: BB threads own conversation, history, status, permissions, and coordination; managed worktrees own branch and filesystem mutation. Show that Telegram ingress never touches a worktree." \
  --style "clean vector-like technical infographic, restrained line icons, crisp sans-serif typography" \
  --composition "landscape 16:9, left-to-right primary flow, two clearly grouped execution boundaries, generous whitespace" \
  --palette "off-white background, Telegram blue, BB indigo, dark neutral text, green only for guarded outcomes" \
  --text "Telegram owner; Durable ingress; SQLite job state; Leased executor; Luna Max controller; Hidden BB thread; Personal workspace; Implementation; Visible BB thread; Managed worktree; Fresh review child; Independent provider conversation; GitHub PR; BB thread boundary; Worktree boundary" \
  --constraints "render labels verbatim; no extra labels; no logos; no watermark; no decorative people; do not imply ingress starts sessions or touches a worktree" \
  --negative "photorealism, 3D effects, tiny text, gradients that reduce contrast, copied Valor branding" \
  --out output/imagegen/telegram-agent-architecture.png \
  --dry-run
```

Expected: payload reports model `gpt-image-2`, size `2048x1152`, quality `high`, and the intended output path.

- [ ] **Step 3: Generate the architecture diagram**

Repeat Step 2 without `--dry-run`. Expected: `output/imagegen/telegram-agent-architecture.png` is created.

- [ ] **Step 4: Dry-run and generate the guarded delivery-loop prompt**

Run the following once with `--dry-run`, inspect the payload, then repeat without `--dry-run`:

```bash
python /root/.codex/skills/.system/imagegen/scripts/image_gen.py generate \
  --model gpt-image-2 \
  --quality high \
  --size 2048x1152 \
  --output-format png \
  --use-case infographic-diagram \
  --prompt "Guarded software delivery loop for Telegram Agent. Show the exact main flow Request to Implement to Resolve exact SHA to Fresh review to Validate to Telegram approval to Merge. Show two remediation loops: Review changes returns to Implement, then a New SHA requires a Fresh review; Validation failure also returns to Implement, then New SHA and Fresh review. Show fail-closed side conditions for Stale SHA, Stale liveness, and Expired approval. State visually that prose review, HTTP success, and cached GitHub metadata are not merge proof." \
  --style "clean vector-like cyclic workflow infographic, restrained arrows, crisp sans-serif typography" \
  --composition "landscape 16:9, strong left-to-right main path, curved remediation arrows below, fail-closed conditions in a separate lower rail" \
  --palette "off-white background, Telegram blue, BB indigo, dark neutral text, green for approval and merge, amber for remediation, red only for fail-closed conditions" \
  --text "Request; Implement; Resolve exact SHA; Fresh review; Validate; Telegram approval; Merge; Review changes; Validation failure; New SHA; Stale SHA; Stale liveness; Expired approval; FAIL CLOSED; Not merge proof: prose review, HTTP success, cached metadata" \
  --constraints "render labels verbatim; no extra stages; no logos; no watermark; preserve cyclic arrows; do not imply automatic merge without Telegram approval" \
  --negative "photorealism, 3D effects, tiny text, decorative characters, copied Valor branding" \
  --out output/imagegen/guarded-delivery-loop.png \
  --dry-run
```

Expected: both the dry run and live generation succeed, and the second PNG is created.

- [ ] **Step 5: Inspect both images**

Use the local image viewer on both files. Verify every required label, the correct arrow direction, readable hierarchy, the thread/worktree distinction, the fresh review context, remediation cycles, and the absence of extra claims or watermarks.

If an image is materially wrong, regenerate only that image with one targeted prompt correction and a versioned output name. Select the verified version; do not edit the diagram with ad hoc drawing code.

- [ ] **Step 6: Copy selected assets into documentation and verify metadata**

```bash
mkdir -p docs/assets
cp output/imagegen/telegram-agent-architecture.png docs/assets/telegram-agent-architecture.png
cp output/imagegen/guarded-delivery-loop.png docs/assets/guarded-delivery-loop.png
file docs/assets/*.png
du -h docs/assets/*.png
```

Expected: both are valid 2048x1152 PNG files at practical repository sizes.

- [ ] **Step 7: Commit the diagram slice**

```bash
git add docs/assets/telegram-agent-architecture.png docs/assets/guarded-delivery-loop.png
git commit -m "docs: add Telegram Agent diagrams"
```

---

### Task 2: Split detailed documentation and rewrite the README

**Files:**
- Modify: `README.md`
- Create: `docs/project-policy.md`
- Create: `docs/operations.md`
- Create: `docs/safety-model.md`

**Interfaces:**
- Consumes: current `README.md`, the two verified PNG assets, `src/plugin.ts`, `src/cli.ts`, `src/config.ts`, `src/controller/service.ts`, `src/services/job-executor-service.ts`, `src/services/telegram-presence.ts`, `src/storage/store.ts`, and the runnable `bb telegram-agent` commands.
- Produces: a concise README and three authoritative deep-reference documents with no lost current claims.

- [ ] **Step 1: Build the claim-verification inventory**

Verify current documentation claims mechanically:

```bash
rg -n "pair|unpair|project|job|doctor" src/plugin.ts src/cli.ts
rg -n "gpt-5.6-luna|max|permissionMode|serviceTier" src/controller src/plugin.ts
rg -n "sendChatAction|4_000|dispatching|submitted|starting|active" src/services src/telegram
rg -n "ls-remote|refs/pull|approval|merge|review|validation" src tests
bb telegram-agent project list --json
bb telegram-agent doctor --json
```

Record claim-to-source evidence in working notes. Do not place machine-specific project IDs, tokens, pairing links, or live job data in documentation.

- [ ] **Step 2: Create the policy reference**

Move and refine the current prerequisites that are specific to enabled sources, the complete policy JSON example, field semantics, input-mode exclusivity, alias rule, project commands, host-specific policy-file command, and project readiness checks into `docs/project-policy.md`.

The document must link back to `../README.md` and to `operations.md` and `safety-model.md` using valid relative links.

- [ ] **Step 3: Create the operations reference**

Move and refine the Telegram conversation flow, job/status behavior, native typing presence, command reference, restart recovery, outbox retry/dead-letter behavior, token rotation, pairing revocation, job retry/cancel semantics, review-limit behavior, and removal guidance into `docs/operations.md`.

Keep one execution engine explicit and state that ingress only enqueues and nudges. Preserve the distinction between ephemeral typing presence and durable milestone/final delivery.

- [ ] **Step 4: Create the safety-model reference**

Move and refine every current safety-boundary bullet into `docs/safety-model.md`. Include dedicated sections for authority and leases, controller permissions, provider-conversation isolation, BB thread identity/history/status/interactions, worktree filesystem isolation, immutable handoffs, fresh-context review, exact Git-native SHA binding, liveness, validation, Telegram approval, and merge proof.

State explicitly that BB threads do not replace worktrees and that threads reusing one environment see the same files.

- [ ] **Step 5: Rewrite the README as the public landing page**

Use this exact heading order:

```markdown
# Telegram Agent
## Why Telegram Agent?
## How it works
## Architecture
## Guarded delivery loop
## Quick start
## Everyday commands
## Safety by construction
## Documentation
```

Embed the images with centered HTML `<img>` tags at widths that fit GitHub (`900` maximum) and descriptive alt text. Keep the quick-start commands runnable and token-safe. Link detailed claims to their owning documents rather than duplicating them.

- [ ] **Step 6: Verify no content or link was lost**

Compare old headings and claim groups against the new document set. Run:

```bash
rg -n "BotFather|npm run check|telegram-agent|policy-json|policy-file|workerLivenessWatchdogMs|maxReviewCycles|typing|git ls-remote|BB threads do not replace worktrees|one-use" README.md docs/*.md
```

Expected: every claim group appears in its intended owner document, and first-install commands remain in the README.

- [ ] **Step 7: Run documentation and project gates**

```bash
npm run check
git diff --check
git status --short
```

Expected: typecheck, 529-or-more tests, and plugin build pass; only intended Markdown and PNG assets are changed.

- [ ] **Step 8: Commit the documentation split**

```bash
git add README.md docs/project-policy.md docs/operations.md docs/safety-model.md
git commit -m "docs: publish concise Telegram Agent guide"
```

---

### Task 3: Guard and final verification

**Files:**
- Review: `README.md`
- Review: `docs/project-policy.md`
- Review: `docs/operations.md`
- Review: `docs/safety-model.md`
- Review: `docs/assets/telegram-agent-architecture.png`
- Review: `docs/assets/guarded-delivery-loop.png`

**Interfaces:**
- Consumes: the complete documentation change from Tasks 1 and 2.
- Produces: verified, committed documentation and final evidence.

- [ ] **Step 1: Apply Docs Guard**

Extract every symbol, command, flag, config key, path, version, number, and behavioral claim. Verify each against source or CLI output. Remove filler, duplicated detail, unverified superlatives, broken links, and implied behavior that the plugin does not implement.

- [ ] **Step 2: Reinspect rendered assets and README references**

Open both final `docs/assets/*.png` files. Verify that README alt text matches the actual diagrams and that the files render at the referenced paths.

- [ ] **Step 3: Run fresh completion gates**

```bash
npm run check
git diff --check
git status --short
git log --oneline -5
```

Expected: every command exits 0, the worktree is clean, and the latest commits contain only the approved documentation scope.

- [ ] **Step 4: Record generation evidence**

Report the final saved asset paths, the two final prompts, explicit CLI mode with model `gpt-image-2`, image dimensions, file sizes, documentation files created, test/build result, and commit IDs.
