# Machines, providers, and models

Resolve execution choices from the machine that will run the work:

```bash
bb machine list --json
bb provider list --machine <machine-id> --json
bb provider models <provider-id> --machine <machine-id> --json
```

An existing environment already fixes its machine, so use `--environment`
instead of combining both selectors. Select only an identifier returned by the
provider on that machine.

Public permission modes are `accept-edits`, `auto`, and `full`. Respect the
machine's configured ceiling. Cursor (`acp-cursor`) and Grok (`acp-grok`) do
not accept `auto`; choose `accept-edits` or `full` within that ceiling.

Cursor does not support `bb thread compact`. When a Cursor or Grok follow-up
fails with `No active ACP session`, revive the existing thread:

```bash
bb acp-session-recover now <thread-id>
```

The choice is complete when the target machine is connected, the exact model
appears in its provider catalog, and the final thread or automation reads back
with the intended provider, model, reasoning level, and permission mode.
