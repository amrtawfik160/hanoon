# Controller Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one controller turn fan work out to several bounded BB threads and receive their combined results as a single follow-up turn, instead of working serially or polling for completion.

**Architecture:** A delegation is a durable fan-out with a join. The controller spawns 1–4 visible BB threads and records them against one delegation row. The existing monitor pass — which already reads thread status and turns a durable obligation into a controller turn — gains a second loop that settles members as they finish and fires one joined turn when the last one lands (or when the join times out).

**Tech Stack:** TypeScript, better-sqlite3 via the plugin storage layer, Zod for tool parameters, Vitest.

## Global Constraints

- Migrations are append-only; add a new named block and register it last in `ALL_MIGRATIONS`. The two migration-position guard tests (`tests/controller-store.test.ts`, `tests/autonomy-migration.test.ts`) must be extended, not relaxed.
- Spawning is a non-transactional side effect. Record the delegation before spawning, and record each member the moment its spawn returns, so a crash mid-fan-out leaves a joinable delegation rather than orphan threads.
- Every joined prompt is bounded: at most 4 members, each summary clipped, and the whole prompt clipped before it reaches a controller turn.
- The delegation tool is mutating, so it runs under the existing `once()` receipt guard.
- The gate is `npm run check`: typecheck, the full Vitest suite, skill-bundle verification, and the plugin build. Baseline is 62 files / 1053 tests at commit `5dd01ee`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/storage/migrations.ts` (modify) | `DELEGATION_MIGRATIONS`: the `delegations` and `delegation_threads` tables. |
| `src/storage/store.ts` (modify) | Delegation records, creation, member recording, settling, firing, and failure. |
| `src/services/monitor-service.ts` (modify) | A second due-pass that settles members and fires the joined turn. |
| `src/controller/tools.ts` (modify) | `telegram_agent_delegate`, registered and receipt-guarded. |
| `src/controller/instructions.ts` (modify) | Teach the agent when to fan out rather than work serially. |
| `tests/controller-delegation.test.ts` (create) | Store bounds and settling, join firing and timeout, and the tool contract. |

---

### Task 1: Delegation storage

**Files:**
- Modify: `src/storage/migrations.ts`, `src/storage/store.ts`
- Modify: `tests/controller-store.test.ts`, `tests/autonomy-migration.test.ts` (migration guards)
- Test: `tests/controller-delegation.test.ts`

**Interfaces:**
- Produces: `DelegationThreadState = "running" | "finished" | "failed" | "missing"`; `DelegationThreadRecord`; `DelegationRecord`; and store methods `createDelegation`, `addDelegationThread`, `listOpenDelegations`, `settleDelegationThread`, `recordDelegationFired`, `failDelegation`, `cancelDelegation`.

- [ ] **Step 1: Write the failing test** covering: a created delegation is `open` with no members; members are added and listed in insertion order; settling a member records its state and clipped summary; settling the same member twice is refused; the open-delegation cap per controller is enforced; and firing moves the row to `fired`.

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run tests/controller-delegation.test.ts`.

- [ ] **Step 3: Add `DELEGATION_MIGRATIONS`**

```sql
CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  controller_key TEXT NOT NULL,
  instruction TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'fired', 'cancelled', 'failed')),
  fired_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX delegations_open ON delegations (state, created_at);
CREATE TABLE delegation_threads (
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'failed', 'missing')),
  summary TEXT,
  settled_at INTEGER,
  PRIMARY KEY (delegation_id, thread_id)
);
```

- [ ] **Step 4: Implement the store methods** with the same shape as the monitor methods: bounded text via `assertMemoryText`, identifiers via `assertControllerIdentifier`, `assertNonNegativeInteger` on clocks, a per-controller open cap of 2, and a per-delegation member cap of 4.

- [ ] **Step 5: Extend both migration-position guards** to the new length and assert the new tail contains `CREATE TABLE delegations`.

- [ ] **Step 6: Run the full suite and commit** — `npm run typecheck && npx vitest run`, then `git commit -m "feat: store controller delegations"`.

---

### Task 2: Settle members and fire the join

**Files:**
- Modify: `src/services/monitor-service.ts`
- Test: `tests/controller-delegation.test.ts`

**Interfaces:**
- Consumes: the Task 1 store methods.
- Produces: `MonitorThreads` gains `output(threadId): Promise<string>`; `MonitorService.processDueDelegations(): Promise<boolean>`.

- [ ] **Step 1: Write the failing test** covering: a delegation whose members are all idle fires exactly one controller turn naming every member; a delegation with one member still active does not fire; a failed member is reported as failed rather than dropped; and a delegation older than the join timeout fires with the unsettled member described as still running.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement `processDueDelegations`** — for each open delegation, refresh each `running` member's status through `threads.status`, settle the ones that reached `idle` / `error` / `missing` (capturing a clipped `threads.output` for the finished ones), then fire when every member is settled or the delegation has outlived `DELEGATION_JOIN_TIMEOUT_MS`. Claim the delegation with `recordDelegationFired` before enqueueing, exactly as `fire` does for monitors, so a crash mid-fire cannot replay it.

- [ ] **Step 4: Run the full suite and commit** — `git commit -m "feat: join delegated threads into one turn"`.

---

### Task 3: The delegate tool and its instruction

**Files:**
- Modify: `src/controller/tools.ts`, `src/controller/instructions.ts`
- Test: `tests/controller-delegation.test.ts`

**Interfaces:**
- Consumes: Task 1 storage, `createProjectThread` from `./thread-observer`.
- Produces: `telegram_agent_delegate` in `CONTROLLER_TOOL_NAMES`.

- [ ] **Step 1: Write the failing test** covering: the tool spawns one thread per task and returns their ids; a spawn failure partway through leaves the already-started threads recorded on an open delegation and reports the partial outcome rather than throwing away the work; and the tool is rejected for an unauthorized thread.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement the tool** — `instruction` plus a 1–4 entry `tasks` array of `{ projectId, title, prompt }`. Create the delegation first, spawn sequentially, record each member as its spawn returns, and return `{ delegation: { id, threads: [...] } }` or `{ outcome: "partial", ... }`.

- [ ] **Step 4: Teach the agent to use it** — one bullet under "What to do" in the controller instructions: independent questions across projects go out together and come back as one result, rather than being worked one at a time.

- [ ] **Step 5: Run the full gate and commit** — `npm run check`, then `git commit -m "feat: let the controller delegate work in parallel"`.

---

### Task 4: Document delegation

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** Describe the fan-out, the durable join, the bounds, and the timeout under a new "Controller delegation" section.
- [ ] **Step 2:** Run `npm run check` and commit.
