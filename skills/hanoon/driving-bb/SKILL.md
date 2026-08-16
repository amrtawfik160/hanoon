---
name: driving-bb
description: "Drive BB from the shell: terminals for anything long-running, waiting on work instead of polling it, environments and diffs, automations, machines and models, and sharing a running server with the owner. Use when your own tools do not cover what is being asked, or when work needs watching while it runs."
---

# Driving BB

Your tools cover jobs, threads, watches, and memory. Everything else BB can do,
you do from the shell with `bb`. You are on the owner's machine with their
authority, and they only have Telegram, so anything that would need a click in
the BB app is yours to run.

`bb guide` is the full reference and `bb guide <chapter>` the detail. Reach for
it when something here is not enough, rather than guessing a flag.

## Never poll

This is the rule that matters most. A loop of `sleep` and `bb thread show` burns
the owner's tokens, competes with the work for the same event loop, and is
usually slower than the thing that already exists:

```bash
bb thread wait <thread-id>                  # blocks until idle, up to 20m
bb thread wait <thread-id> --timeout 600    # or your own budget
bb terminal wait <terminal-id> --contains "Local:" --timeout 120
```

For anything longer than one turn, arm a watch instead and let it wake you.
Repeatedly reading status, logs, or output is the wrong shape every time.

## Long-running commands

Anything that does not end on its own — a dev server, a test watcher, a build, a
REPL — belongs in a terminal, not a foreground shell. The owner can see it, and
so can you, for as long as it runs.

```bash
bb terminal create --thread <thread-id> --title "dev" --command "npm run dev"
bb terminal wait <terminal-id> --contains "ready in" --timeout 120
bb terminal output <terminal-id> --json          # bounded; continue with --since-seq
bb terminal send <terminal-id> --text "rs" --enter
bb terminal close <terminal-id>
```

Scope is exactly one of `--thread`, `--environment`, or `--machine`. Everything
after creation needs only the terminal id.

## Showing the owner something running

They are remote and cannot open `localhost`. When you have started a server they
should see, expose the port and give them the URL as a link:

```bash
bb connect expose <port>        # prints the public URL for this thread's host
bb connect status               # every share, with its host
```

Pair this with a screenshot when a still is enough, and a link when they need to
click around themselves.

## Looking at work

```bash
bb thread show <thread-id> --json     # status, environment, PR, result
bb thread show <thread-id> --git-diff # what it changed
bb thread log <thread-id>             # the conversation
bb thread output <thread-id>          # its last answer
```

For the workspace behind a thread, take `environmentId` from `--json` and read
it directly:

```bash
bb environment status <env-id>
bb environment diff <env-id> --json
bb environment pull-request show <env-id>
```

## Steering

A message can land in a running turn or wait for it:

```bash
bb thread tell <id> "Stop and use approach B" --mode steer   # immediate
bb thread tell <id> "When you are done, also update the README" --mode queue
```

Steer for a wrong direction or a hard stop. Queue for a follow-up that can wait.

## Scheduled work

Monitors are yours. BB automations are for the owner's recurring work, and a
check whose output is fully determined by code should be a script, not an agent
run — it costs no tokens per tick and stays silent when there is nothing to say:

```bash
bb automation create --project <id> --name "..." --cron "0 9 * * 1-5" \
  --timezone "..." --script-file ./check.sh
bb automation list --project <id>
```

A script that exits 0 with empty stdout says nothing. Make it exit non-zero only
when it genuinely failed.

## Machines, providers, models

```bash
bb machine list --json
bb provider list --json
bb provider models <provider-id> --json
```

Never guess a model id: ask the provider on the machine the work will run on.

## When something fails

Read before deciding. `bb thread show <id> --json` and `bb thread log <id>` tell
you whether to retry, clarify, or say something to the owner. If the owner
stopped a thread themselves, that was deliberate: leave it alone unless they say
otherwise.

```bash
bb thread retry <id>       # continue an interrupted turn
bb thread stop <id>        # when it is stuck or no longer wanted
bb thread compact <id>     # when its context is the problem
```
