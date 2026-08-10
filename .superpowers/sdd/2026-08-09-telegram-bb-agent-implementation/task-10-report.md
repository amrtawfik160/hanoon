# Task 10 evidence

## Scope

Implemented Task 10 only: pure Telegram ingress, singleton leased executor,
effect dispatch, worker liveness, reconciliation enqueueing, and outbox
recovery. Task 11 and Task 12 were not implemented.

## RED

Command:

```text
npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
```

Result: exit 1 as intended. The plugin registration assertion failed because
the two services were not registered, and the four new service suites failed
during collection because their service modules did not yet exist.

## GREEN and verification

Focused service gate:

```text
npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
```

Exit 0. Five test files and 30 tests passed.

Full suite:

```text
npm test
```

Exit 0. Twenty-one test files and 423 tests passed. No leaked Vitest handles
were reported.

Typecheck:

```text
npm run typecheck
```

Exit 0.

Build:

```text
npm run build
```

Exit 0. The build emitted `dist/server.js`, `dist/server.js.map`, and
`dist/server.meta.json`.

Aggregate check:

```text
npm run check
```

Exit 0. The aggregate reran typecheck, the full 21-file/423-test suite, and
the plugin build successfully.

Diff validation:

```text
git diff --check
```

Exit 0 with no whitespace errors.

The final reliability pass was limited to initial unknown liveness projection
on BB lookup failure, race-safe one-time stale/unknown owner warning outbox
emission, and removal of dead imports/unused parameters. The fresh independent
BB review is performed by the root thread after the scoped commit.
