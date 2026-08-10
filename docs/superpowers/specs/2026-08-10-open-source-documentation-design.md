# Open-source documentation design

Date: 2026-08-10

## Outcome

Turn the repository documentation into a concise public entry point for operators and contributors. The presentation should borrow Valor's strongest pattern—identity, motivation, mental model, quick start, architecture, repository map, and deeper links—without copying its claims or documenting features this plugin does not have.

## Audiences

The documentation serves three readers in order:

1. an evaluator deciding whether the plugin fits their workflow;
2. an operator installing it and connecting one Telegram owner to BB;
3. a contributor changing the TypeScript plugin safely.

The README optimizes for the first reader and provides the shortest safe path for the second. Detailed configuration and recovery material moves into focused documents. Contributor-specific setup belongs in `CONTRIBUTING.md`.

## Public information architecture

### README

The README becomes a landing page with:

- a one-sentence product definition and explicit Valor attribution;
- a short "Why" section grounded in implemented behavior;
- a three-layer architecture summary;
- a compact end-to-end pipeline;
- a warning that the plugin can run commands, merge, deploy, and canary;
- prerequisites and a minimal install/pair/doctor quick start;
- a repository map and links to deeper documentation;
- a concise status statement that avoids unsupported maturity claims.

It must not contain the full project policy schema, every recovery case, or the complete thirteen-stage operational narrative.

### Public docs

- `docs/README.md` — documentation index and audience routing.
- `docs/architecture.md` — ownership boundaries, durable state, BB thread versus worktree isolation, and reviewed delivery pipeline.
- `docs/configuration.md` — controller settings, pairing, project policy shape, and project enablement.
- `docs/operations.md` — inspection, recovery, token rotation, unpairing, and removal.
- `docs/live-acceptance.md` — renamed and cleaned disposable acceptance runbook.

The existing `docs/superpowers/` plans and specifications remain intact as design history. The public docs index identifies them as implementation history, not operator documentation.

### Repository governance docs

- `CONTRIBUTING.md` — setup, validation commands, change boundaries, pull-request evidence, and secret hygiene.
- `SECURITY.md` — private-reporting guidance, credential rules, operational risk, and supported-version limitations.

No license file or license badge is created. Choosing copyright terms is a maintainer decision and cannot be inferred from the Valor reference.

## Diagrams

Use GitHub-native Mermaid, not generated raster artwork. Two small diagrams are enough:

1. Telegram ingress → durable SQLite state/outbox → single leased executor → BB controller and reviewed worktree pipeline → Telegram delivery.
2. Plan → critique → implement → validate → fresh review → documentation → final validation/review → owner approval → merge → deploy → canary, including remediation and fail-closed loops.

The diagrams are conceptual maps. Exact state names, stage ordering, and boundaries must match `src/domain/pipeline-graph.ts`, `src/domain/state-machine.ts`, and `src/plugin.ts`.

## Accuracy and safety rules

- Do not claim the plugin is production-ready, autonomous without oversight, published, supported, or licensed.
- Do not include badges until a real CI workflow, release, package, and license exist.
- Do not expose a bot token, pairing link, callback nonce, private path, provider credential, or raw private transcript.
- State that this is a full-trust BB plugin and that project policies contain owner-authored commands.
- State that only one private Telegram owner and one active job are supported.
- Keep controller settings separate from immutable per-project worker settings.
- Explain that BB threads isolate provider conversations and coordination while worktrees remain the code/filesystem isolation boundary.
- Explain that merge approval is bound to Git-native pull-request head evidence and remains subject to GitHub protection.
- Require a disposable repository for live acceptance.

## Verification

Documentation verification must include:

1. every documented command checked against `src/cli.ts` or live command output;
2. settings and defaults checked against `src/plugin.ts`, `src/config.ts`, and `src/controller/execution-profile.ts`;
3. policy fields checked against `src/domain/models.ts`;
4. pipeline claims checked against the graph, state machine, executor, review, merge, and production services;
5. every relative Markdown link resolved;
6. every Mermaid block parsed or rendered by an available validator;
7. `git diff --check`, the full project check, and `bb plugin types --check .` passing;
8. a docs-only diff, apart from file moves and governance Markdown files.

## Scope exclusions

- Runtime code, tests, plugin settings, and package metadata do not change.
- No logo, screenshot, demo GIF, or generated image is added.
- No GitHub Actions workflow, issue template, release automation, npm publication, or website is added.
- No existing design-history content is rewritten.
