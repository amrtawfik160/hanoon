# README Information Architecture Design

## Goal

Turn the repository README into a concise public landing page while preserving the current operational, policy, and safety documentation in focused files under `docs/`. The presentation takes structural inspiration from Valor's README—short value proposition, architecture visual, workflow visual, quick start, then deeper references—without copying its language or branding.

## Audience and hierarchy

The primary README audience is a BB user evaluating or installing Telegram Agent. They should understand what it does, why its guarded workflow is different from a generic chat bot, and how to get started before encountering implementation detail.

The README will use this order:

1. Project name and one-sentence promise.
2. Four concise reasons to use it.
3. System architecture diagram and a short explanation of the execution boundary.
4. Guarded delivery-loop diagram and the behavior of implementation, fresh-context review, validation, approval, and merge.
5. Quick start: prerequisites, install, token configuration, pairing, project enablement, and readiness check.
6. Small command reference for routine operation.
7. Safety guarantees.
8. Links to the detailed policy, operations, safety, and acceptance documentation.

## Documentation split

The existing README content remains authoritative but moves by responsibility:

- `docs/project-policy.md` owns the complete policy JSON shape, validation rules, project enable/disable commands, host selection, and readiness checks.
- `docs/operations.md` owns job commands, Telegram conversation behavior, liveness/presence behavior, restart and delivery recovery, token rotation, unpairing, and removal guidance.
- `docs/safety-model.md` owns the trust model, single execution engine, lease and generation fences, BB thread versus worktree isolation, immutable handoffs, exact-SHA binding, fresh review context, validation, approval, and merge proof.
- `docs/acceptance-test.md` remains the disposable live-test procedure.

The README links to these documents rather than duplicating their full content. Commands required for first installation remain in the README.

## Generated diagrams

Two raster diagrams will be generated with the explicit GPT Image 2 CLI path and saved as PNG files in `docs/assets/`. Both use a clean off-white background, Telegram blue, BB indigo, dark neutral text, and green approval accents. They use a restrained vector-like technical illustration style with generous whitespace, readable labels, no logos, no watermarks, and no decorative characters.

### System architecture

Filename: `docs/assets/telegram-agent-architecture.png`

Landscape flow:

`Telegram owner` -> `Durable ingress` -> `SQLite job state` -> `Leased executor`

The executor branches to:

- `Luna Max controller` inside a `Hidden BB thread` and `Personal workspace`.
- `Implementation` inside a `Visible BB thread` and `Managed worktree`.
- `Fresh review child` reusing the managed worktree but owning an independent provider conversation.
- `GitHub PR` as the external merge target.

The image must make two boundaries explicit: BB threads own conversation/history/status/permissions/coordination, while managed worktrees own branch/filesystem mutation. Telegram ingress never touches a worktree.

### Guarded delivery loop

Filename: `docs/assets/guarded-delivery-loop.png`

Landscape cyclic flow:

`Request` -> `Implement` -> `Resolve exact SHA` -> `Fresh review` -> `Validate` -> `Telegram approval` -> `Merge`

Failure edges:

- Review changes -> implementation remediation -> new SHA -> fresh review.
- Validation failure -> implementation remediation -> new SHA -> fresh review.
- Stale SHA, stale liveness, or expired approval -> fail closed and re-run the required gate.

The visual must not imply that prose review, HTTP success, or cached GitHub metadata can authorize merge.

## Accuracy and quality gates

- Every command, flag, config key, file path, default, and behavioral claim is verified against the current source or runnable CLI.
- Generated images are inspected for label accuracy, hierarchy, legibility, and absence of extra or misleading elements before README integration.
- PNG dimensions and file sizes are recorded; web copies should remain readable in GitHub's standard README width.
- All relative links and image paths resolve from `README.md`.
- `npm run check` and `git diff --check` pass after the documentation-only change.
- Docs Guard verifies the final README and all newly split documentation before commit.

## Scope boundary

This change modifies documentation and generated documentation assets only. It does not change plugin behavior, settings, storage, tests, packaging, or live services.
