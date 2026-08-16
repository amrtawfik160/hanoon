---
name: checking-system-logs
description: "Find what this plugin actually did: its own log, the turns and messages it recorded, and a specific BB thread's history. Use when diagnosing a wrong reply, a message that did not arrive, a turn that failed, or any question of the form 'what did it do at 09:41'."
---

# Checking system logs

Three surfaces, and the order matters. Most wrong answers about behaviour come
from reading only the first one.

Always narrow by time or keyword. A tail of a busy log buries the thing you are
looking for, and a wall of output in a transcript is worse than no output.

## 1. The plugin's own log

What the services logged: polling failures, refusals, warnings from the sweeps.

```bash
bb plugin logs telegram-agent -n 200 | grep -iE "error|warn|refus"
```

This is the only surface that shows a failure the plugin *handled*. A step that
was skipped deliberately appears here and nowhere else.

## 2. What it recorded (the store)

The durable record: every turn taken, every message queued or sent. This is the
authoritative answer to "what did it actually do", because the log can be silent
while the store is not.

```bash
python3 - <<'EOF'
import sqlite3, datetime
c = sqlite3.connect('/root/.bb-server/plugins/telegram-agent/data.db')
for r in c.execute("SELECT origin, state, created_at, substr(input_text,1,80) "
                   "FROM controller_turns ORDER BY created_at DESC LIMIT 12"):
    ts = datetime.datetime.fromtimestamp(r[2]/1000).strftime('%H:%M:%S')
    print(ts, r[0], r[1], r[3].replace('\n', ' '))
EOF
```

The tables worth knowing:

- `controller_turns` — one row per turn, with `origin` (`owner` or `system`) and
  `state`. Two turns close together with different origins is the shape of a
  reply that mixed two subjects.
- `outbox` — one row per outgoing message, with `payload_json` and the Telegram
  `message_id`. This is what was *sent*, as opposed to what was meant.
- `housekeeping_notices` — what the daily sweeps claimed, and when.

Read the outbox before concluding anything about a message the owner saw. The
message ids give the real order, which is not always the order rows were created.

## 3. A specific thread

When the question is about work the controller delegated:

```bash
bb thread show <thread-id> --json     # status, environment, result
bb thread log <thread-id>             # the conversation
bb thread output <thread-id>          # just the final answer
```

## Reading it honestly

State which surface an answer came from. "The log shows no error" and "the store
shows the turn completed" are different claims, and only the second one says the
work happened.

When a surface is empty, say it is empty rather than treating that as proof. A
missing log line means the log is missing a line.
