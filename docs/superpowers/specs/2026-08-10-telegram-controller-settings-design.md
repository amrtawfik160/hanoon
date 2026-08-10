# Telegram Controller Execution Settings

Date: 2026-08-10

## Outcome

Expand **Extensions → Plugins → Telegram Agent** so an operator can change the Telegram conversational controller's Codex model, reasoning level, service tier, and permission mode without editing source code. Existing installations preserve the current Luna Max/Fast/Auto behavior through defaults.

## Scope boundary

These settings control only the hidden Telegram conversational controller. Implementation and review workers remain governed by each enabled project's immutable policy snapshot. Planner, critic, documentation, validation, merge, deploy, and canary behavior do not inherit a mutable controller setting.

This separation prevents a settings change from altering an active delivery job or invalidating its review evidence.

## Settings

The existing bot token, BB URL, and poll timeout remain. Add four static BB-supported select controls:

| Setting | Options | Default |
| --- | --- | --- |
| Controller model | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.4` | `gpt-5.6-luna` |
| Controller reasoning | `low`, `medium`, `high`, `xhigh`, `max` | `max` |
| Controller service tier | `fast`, `default` | `fast` |
| Controller permission mode | `auto`, `accept-edits`, `full` | `auto` |

The model list stays within the installed Codex provider family. The common reasoning options avoid combinations known to be unavailable across those presets. BB and the execution machine still enforce provider availability and the machine's maximum permission mode.

## Runtime behavior

Configuration parsing validates every execution field and exposes one typed controller execution profile. The BB controller adapter reads the profile once when it starts a turn and passes every field with explicit input-source metadata on both thread spawn and later sends.

Saving settings updates the in-memory profile used by subsequent turns. An already running turn keeps the profile with which it started. The durable controller thread and conversation history remain intact when the model changes; Codex receives the selected model and reasoning settings on the next turn.

If the settings are missing, defaults reproduce the current Luna Max/Fast/Auto tuple. Invalid stored values put the plugin into **Needs configuration** rather than silently falling back to another model.

## Safety and recovery

- The provider stays fixed to `codex`; the settings page cannot create provider/model mismatches.
- Controller authorization, hidden visibility, owner pairing, durable FIFO turns, and fail-closed recovery remain unchanged.
- Project policy snapshots remain the only source of implementation and review execution settings.
- Changing controller settings never rewrites an active job, approval, review receipt, or worktree.

## Verification

Tests must prove:

1. settings defaults parse to Luna/Max/Fast/Auto;
2. every non-default selection survives parsing;
3. spawn and later send use the selected tuple with explicit source metadata;
4. project implementation/review execution remains policy-driven;
5. TypeScript, the full Vitest suite, plugin build, generated SDK type check, and plugin reload pass.

Live acceptance requires the settings page to show all four dropdowns and a subsequent Telegram turn to create/send with the saved tuple.
