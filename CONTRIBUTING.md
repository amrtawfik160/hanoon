# Contributing

Thanks for improving Telegram Agent. Changes should preserve the plugin's durable, fail-closed pipeline and keep the Telegram surface bounded and secret-safe.

## Development setup

You need BB `0.36` or newer, npm, and the toolchains required by the tests. Install the locked dependencies:

```bash
npm ci
```

Run a focused Vitest file while developing:

```bash
npx vitest run tests/controller-service.test.ts
```

Run the complete gate before committing:

```bash
npm run check
bb plugin types --check .
```

The full check performs TypeScript validation, the complete Vitest suite, and a BB plugin build. The SDK check confirms the vendored plugin declarations still match the installed BB contract.

## Change boundaries

- Telegram ingress is I/O only: accept, authenticate, persist, and nudge. It must not spawn BB sessions or touch worktrees.
- The leased executor is the only execution engine. New paths that start work must go through its generation fence and durable effects.
- Project policy is immutable for an active job. Do not let mutable controller settings rewrite worker execution.
- Reviews use newly spawned BB threads with fresh provider conversations. Do not fork or resume the implementation conversation for review.
- BB threads do not replace worktrees. Threads own conversation/history/status/permissions; the worktree owns branch, checkout, files, and artifacts.
- Merge evidence uses the full head from `git ls-remote origin refs/pull/<number>/head`. Do not substitute cached API metadata.
- Merge, deploy, and canary require distinct durable receipts. Never infer completion from an HTTP success or prose response.
- Secrets, pairing links, callback nonces, raw private messages, and credential-like output must not enter fixtures, logs, documentation, or persisted evidence.

## Tests

Add the smallest behavior-focused test that proves the change. Use the real plugin test harness and real temporary SQLite storage where persistence is under test. Mock BB, GitHub, Telegram, terminal, clock, or provider calls only at their system boundaries.

For state-machine work, cover the exact state/event transition, idempotency, stale version, lease generation, and terminal outcome. For prompt/agent work, test required structural contracts rather than exact prose. For a production regression, keep the incident date or issue reference in the test name or a short rationale comment.

Never weaken, skip, or replace a failing test with a canned production success path.

## Documentation

Public operator docs live in [`docs/`](docs/README.md). Design history lives under `docs/superpowers/` and is not the source of truth for current commands or settings.

When behavior changes:

1. verify command forms against `src/cli.ts` or live CLI output;
2. verify settings/defaults against `src/plugin.ts`, `src/config.ts`, and `src/controller/execution-profile.ts`;
3. verify policy fields against `src/domain/models.ts`;
4. update every public document that describes the changed behavior;
5. run `git diff --check` and resolve every relative Markdown link.

Do not add badges, compatibility claims, release status, or performance numbers without a repository source that proves them.

## Pull requests

Keep each pull request focused. Include:

- the behavior or documentation problem being solved;
- the files and trust boundaries affected;
- RED → GREEN evidence for a bug fix or behavior change;
- focused and full verification commands with their results;
- any live testing performed, clearly separated from mocked/local evidence;
- deployment or canary status only when it was actually run.

Do not include credentials, private repository paths, raw Telegram conversations, or unredacted command output in a pull request.
