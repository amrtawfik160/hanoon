# Telegram Controller Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated controller model, reasoning, service-tier, and permission dropdowns to the Telegram Agent plugin settings and apply them to subsequent controller turns.

**Architecture:** A small execution-profile module owns the supported option tuples and defaults. Global config validates the stored selections, the plugin declares them through BB's native `select` descriptors, and `BbControllerAdapter` reads one profile at the start of each spawn/send. Project implementation and review policies remain unchanged.

**Tech Stack:** TypeScript, Zod, BB Plugin SDK settings and thread SDK, Vitest.

## Global Constraints

- Provider remains fixed to `codex`.
- Defaults remain `gpt-5.6-luna`, reasoning `max`, service tier `fast`, permission mode `auto`.
- Model choices remain `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol` so every exposed reasoning level is valid.
- Controller settings never modify active or stored project job policies.
- Use BB native settings descriptors; do not add a custom frontend or dependency.
- Follow RED → GREEN TDD and preserve owner pairing, FIFO, recovery, and hidden-thread behavior.

---

### Task 1: Typed controller execution profile and config parsing

**Files:**
- Create: `src/controller/execution-profile.ts`
- Modify: `src/config.ts`
- Modify: `src/services/telegram-service.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Produces: `ControllerExecutionProfile`, option tuples, `DEFAULT_CONTROLLER_EXECUTION_PROFILE`, and `controllerExecutionProfile(config)`.
- Consumes: BB-supported Codex model identifiers and execution enum values.

- [ ] **Step 1: Write failing configuration tests**

Test that missing execution values produce the Luna/Max/Fast/Auto defaults, all non-default values survive parsing, and an unknown model returns `ok: false`.

```ts
expect(parseGlobalConfig({
  botToken: "123:test",
  bbAppBaseUrl: "",
  pollTimeoutSeconds: "30",
})).toMatchObject({
  ok: true,
  value: {
    controllerModel: "gpt-5.6-luna",
    controllerReasoningLevel: "max",
    controllerServiceTier: "fast",
    controllerPermissionMode: "auto",
  },
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/config.test.ts`

Expected: FAIL because the parsed config has no controller execution fields.

- [ ] **Step 3: Add the execution-profile module and schema defaults**

Define readonly tuples for the exact settings options, derive union types from those tuples, and expose:

```ts
export type ControllerExecutionProfile = {
  model: ControllerModel;
  reasoningLevel: ControllerReasoningLevel;
  serviceTier: ControllerServiceTier;
  permissionMode: ControllerPermissionMode;
};
```

Add corresponding defaulted Zod fields to `globalConfigSchema` and a pure `controllerExecutionProfile(config)` projection.

- [ ] **Step 4: Narrow Telegram polling's config dependency**

Replace its dependency on the complete `GlobalConfigResult` with a local union whose successful value contains only `botToken` and `pollTimeoutSeconds`. This keeps polling tests and the service contract independent from controller execution settings.

- [ ] **Step 5: Run focused config and Telegram service tests**

Run: `npx vitest run tests/config.test.ts tests/telegram-service.test.ts`

Expected: PASS.

---

### Task 2: Settings descriptors and runtime controller wiring

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/controller/bb-controller.ts`
- Modify: `tests/plugin.test.ts`
- Modify: `tests/controller-service.test.ts`

**Interfaces:**
- Consumes: `ControllerExecutionProfile`, option tuples, and `controllerExecutionProfile(config)` from Task 1.
- Produces: four BB-native select descriptors and profile-aware controller spawn/send behavior.

- [ ] **Step 1: Write failing descriptor and adapter tests**

Assert the registered settings descriptors expose the exact model/reasoning/tier/permission options and defaults. Construct the real adapter with a Terra/High/Default/Accept-edits profile and assert both spawn and send use that tuple with explicit source metadata.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/plugin.test.ts tests/controller-service.test.ts`

Expected: FAIL because descriptors are absent and the adapter still uses constants.

- [ ] **Step 3: Declare native select settings**

Add `controllerModel`, `controllerReasoningLevel`, `controllerServiceTier`, and `controllerPermissionMode` to `bb.settings.define`, using copied readonly option arrays and concise descriptions of their scope.

- [ ] **Step 4: Inject a live profile query into the adapter**

Require `executionProfile: () => ControllerExecutionProfile` in `BbControllerAdapter` dependencies. Read it once per `spawn` or `send`; keep provider `codex`, visibility, plugin origin, title, and recovery matching unchanged. In `createPlugin`, project the current parsed config so `settings.onChange` affects the next turn.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run tests/config.test.ts tests/plugin.test.ts tests/controller-service.test.ts tests/telegram-service.test.ts`

Expected: PASS.

---

### Task 3: Documentation, guards, and live activation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-10-telegram-controller-settings-design.md` only if implementation reveals a contradiction.

**Interfaces:**
- Consumes: the verified settings descriptors and runtime behavior from Tasks 1–2.
- Produces: operator documentation and a live installed plugin using the new profile.

- [ ] **Step 1: Update the README settings section**

Document every controller option/default, state that they affect subsequent controller turns only, and preserve the immutable per-project worker-policy boundary.

- [ ] **Step 2: Run Test Guard, Clean Code Guard, and Docs Guard**

Review only the changed tests, production files, and documentation. Fix behavior assertions that mock internals, speculative options, stale claims, or unsafe permission language.

- [ ] **Step 3: Run the complete verification gate**

Run:

```bash
git diff --check
npm run check
bb plugin types --check .
```

Expected: all commands exit 0 and Vitest reports zero failures.

- [ ] **Step 4: Commit and reload the plugin**

```bash
git add README.md src tests docs/superpowers
git commit -m "feat: configure Telegram controller execution"
bb plugin reload telegram-agent
```

- [ ] **Step 5: Verify the installed settings and services**

Use `bb plugin list --json` to require plugin status `running`, both services `running`, no handler errors, and the four descriptors in the plugin inspection tests. Confirm `bb telegram-agent doctor` still passes token and owner pairing.
