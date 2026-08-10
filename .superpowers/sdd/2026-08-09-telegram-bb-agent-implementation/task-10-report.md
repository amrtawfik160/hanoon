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

## Task 10 review round 1 bounded fix

Only the listed review findings were addressed. The fix covers authoritative
BB-thread reconciliation into guarded state-machine events, leased-executor
gate collection, cancellation stop confirmation with a bounded
`cancellation_unconfirmed` block, executor-fenced projections, distinct worker
registration generations, terminal liveness projection, normalized status
outbox keys, durable callback answers, permanent effect-conflict handling, and
single-key merge completion. Task 11 and Task 12 remain untouched.

RED regression gate:

```text
npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
```

Exit 1 as intended after the first scoped regression-test edit: the new
permanent-conflict assertion observed `failed` instead of `dead`, and the
authoritative implementation-idle assertion observed the pre-reconciliation
state.

Focused GREEN gate:

```text
npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
```

Exit 0. Five test files and 34 tests passed.

Additional bounded merge regression gate:

```text
npm test -- tests/merge.test.ts
```

Exit 0. One test file and 101 tests passed.

Required verification gates:

```text
npm test
npm run typecheck
npm run build
npm run check
git diff --check
```

All exited 0. The full and aggregate test runs each passed 21 test files and
427 tests; the build emitted `dist/server.js`, `dist/server.js.map`, and
`dist/server.meta.json`; and the final diff check reported no whitespace
errors.

## Task 10 review round 2 bounded residual fix

Only the two listed residuals were addressed. Fresh-gate validation now wires
authoritative terminal observations into validation liveness. Validation and
post-merge confirmation project explicit `timed_out`/`aborted` outcomes as
failed terminal observations, with merge confirmation observing both Git-native
and GitHub confirmation commands. Telegram polling, token rotation, heartbeat,
and timeout lifecycle coverage now uses fake timers and asserts no leaked
handles. Task 11 and Task 12 remain untouched.

RED regression evidence:

```text
npm test -- tests/merge.test.ts -t "projects a post-merge confirmation timeout as failed terminal liveness"
Exit 1 as intended: expected no liveness record, received null.

npm test -- tests/plugin.test.ts -t "projects fresh-gate validation terminal observations into liveness"
Exit 1 as intended: expected validation liveness, received null.

npm test -- tests/validation.test.ts -t "projects a timed-out validation terminal as failed liveness"
Exit 1 as intended: only the running observation was emitted; the timed_out
observation was absent.
```

GREEN and verification gates:

```text
npm test -- tests/terminal-command.test.ts tests/validation.test.ts tests/worker-liveness.test.ts tests/telegram-service.test.ts tests/merge.test.ts tests/plugin.test.ts
Exit 0. Six test files and 168 tests passed.

npm test -- tests/effect-runner.test.ts tests/telegram-service.test.ts tests/worker-liveness.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
Exit 0. Five test files and 37 tests passed.

npm test -- tests/merge.test.ts
Exit 0. One test file and 102 tests passed.

npm test
Exit 0. Twenty-one test files and 432 tests passed.

npm run typecheck
Exit 0.

npm run build
Exit 0. The build emitted `dist/server.js`, `dist/server.js.map`, and
`dist/server.meta.json`.

npm run check
Exit 0. The aggregate reran typecheck, the full 21-file/432-test suite, and
the plugin build successfully.

git diff --check
Exit 0 with no whitespace errors.
```
