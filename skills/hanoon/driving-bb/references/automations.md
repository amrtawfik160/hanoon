# BB automations

Use BB as the single clock for recurring and one-shot work. Hanoon monitors
remain for lifecycle events such as a thread becoming idle; a wall-clock task
must not also have an armed Hanoon cron row.

Pass `--project` on every command. Use BB's first-party automation command:

```bash
bb automation <command> --project <id>
```

## Choose the execution mode

Use `script` when code fully determines the result: health probes, watchdogs,
threshold checks, and fixed commands. Exit 0 with empty output when there is
nothing to report. A non-zero exit means the run itself failed.

```bash
bb automation create --project <id> --name "..." \
  --cron "0 9 * * 1-5" --timezone "America/New_York" \
  --script-file ./check.sh --interpreter bash --timeout 120000
```

Use `agent` when the result needs judgment, investigation, summarizing, or an
SDLC workflow. Resolve the provider/model on the target machine first.

```bash
bb automation create --project <id> --name "..." \
  --cron "0 23 * * *" --timezone "Etc/UTC" \
  --provider codex --model gpt-5.6-sol --reasoning high \
  --permission-mode auto --new-environment worktree --base-branch main \
  --prompt "objective, authority limit, expected evidence, reporting rule"
```

Use `--at <ISO-8601>` or `--in 30m` instead of `--cron` for one-shot work.
Agent targets are mutually exclusive: `--target-thread`, `--environment`, or
`--new-environment worktree`. Automation-created threads cannot create or
widen another automation.

## Manage and reconcile

```bash
bb automation list --project <id> --json
bb automation show <automation-id> --project <id> --json
bb automation update <automation-id> --project <id> ...
bb automation pause <automation-id> --project <id>
bb automation resume <automation-id> --project <id>
bb automation run <automation-id> --project <id> --idempotency-key <key>
bb automation runs <automation-id> --project <id> --limit 10 --json
bb automation delete <automation-id> --project <id> --yes
```

BB permits one active run per automation. A recurring run retries after 30 and
60 seconds, then pauses on its third consecutive failure. Success, a silent
script tick, or an explicit resume resets the failure count.

After create or update, `show` must match the intended project, trigger,
timezone, execution mode, target, provider/model route, permission ceiling,
and next run. After a run, use `runs` to bind the report to its run id and
captured outcome. Command success without that read-back is incomplete.
