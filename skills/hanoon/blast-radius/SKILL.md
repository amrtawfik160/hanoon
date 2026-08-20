---
name: blast-radius
description: "Find what a change could break somewhere else before it ships, beyond the diff, and prove the one fact it is safe because of by running real code instead of writing it up. Use when reviewing a change for what it could break elsewhere, judging risk beyond the changed lines, or reading a small diff that looks safe and is not trusted yet."
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Use it when the risk is not visible inside the changed lines, when a small diff looks safe and you do not trust that yet, and whenever the verdict you are about to return could let the change merge unattended.

Listing the callers is not the job. Grep finds those in a second. The job is the breakage grep will not show you.

## The output you are writing

You review a pull-request head in a managed worktree. You never edit the change. What you produce is a review verdict: a summary, structured findings bound to the exact head SHA, and the checks you ran. Everything below is aimed at that verdict, not at a standalone writeup for a human reader.

Two rules follow from that contract:

- A finding turns a pass into changes requested. File a finding only for a risk worth holding the merge for. What you checked and cleared, and any safety fact you could not prove, belongs in the summary.
- Record every script or test you ran as a check, with its exact command and exit code. Mark a check failed only when the run itself shows the change is unsafe, because a failed check requests changes on its own.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it is true, and that is the trap you are walking into. So don't hand back the writeup. Find the one or two facts the whole thing depends on and prove them by running code. Words are where you start, not what you ship.

### How sure are you

For each fact the change's safety depends on, get it as far down this list as is cheap, and say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You showed the bad case can't happen. You walked the failure step by step and it doesn't reach.
4. You ran it. A script or test that calls the real code and fails loud if you're wrong.
5. You reproduced it in the running app.

Any safety fact you can't get to step 4, say so out loud. Don't write it up as settled and don't round it up. Step 4 is usually one small script that imports the same library the app ships and calls the exact function you're worried about.

## Proof scripts never touch the repository

A dirty review environment throws your own verdict away, and the merge gate counts an untracked file as dirty too, so one scratch file left behind costs the review and then blocks the merge it was for. Write the script under a temporary directory outside the worktree, from `mktemp -d`, or delete it completely when you are done. Never modify a tracked file and never leave an untracked one. Point the script at the worktree from outside it. `git status` in the worktree has to be as clean when you finish as it was when you started.

## Steps

1. Read the change. The diff, the symbols it adds, changes, and deletes, and what it now does differently, including the part the diff doesn't spell out. The packet's pull request and commits are the record of what was asked for.
2. Find the one fact it's safe because of. Most changes that look scary are safe because of a single fact, like "this call only drops already-dead cache entries and does nothing else". Find that fact. If it holds, most of the scary cases die at once. Spend your time here, not on a long list of maybes.
3. Look where grep stops. Read the source of the library you call, and check its pinned version and any local patch. Work out when things run: microtasks, teardown, retries, ordering between two processes. Follow what a symbol search misses: the JSON an API returns, a DB column, a wire format, another language reading the same bytes, a feature flag, code three hops downstream.
4. Be honest about each risk. Give it a real chance of happening and a real cost if it does. Keep the risks you confirmed as findings; the ones you checked and cleared go in the summary instead. Cite a real `file:line`. A search that finds nothing is still an answer. Never make up a caller or an API.
5. Prove the one fact. Write a script or test that runs the real code, run it, and quote what happened. If you can't prove it cheaply, mark it unproven.
6. Say what stayed unproven, in the verdict itself. You may not be the only lens on this head. Another lens can be reading the same change on another provider, and the pipeline decides from what each review returns. So an unproven safety fact or a confirmed risk counts only if you write it down where the verdict machinery reads it. A summary that reads clean because the doubt was smoothed out of it is the failure this skill exists to prevent.

## What the verdict carries

- **Summary.** What the change does, including the part that isn't obvious. The one fact it's safe because of, which step you got it to, and the proof. If you couldn't prove it, the word unproven. What you checked and cleared. The cheapest test or repro that would catch the real bug, including the script you wrote.
- **Findings.** Only the real risks. Each one names how it breaks, the `file:line`, how likely and how bad, and how to check it. Severity matches the cost you just argued for, not the effort the risk took to find.
- **Checks.** Every command you ran to prove or disprove a safety fact, with its exit code.

Cite real code and quote real output. If the one safety fact never reached "you ran it", the verdict says so in plain words.
