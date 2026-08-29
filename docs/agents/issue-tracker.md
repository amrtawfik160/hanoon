# Issue Tracker: GitHub

Issues and specifications for this repository live as GitHub issues. Use the `gh` CLI for all operations and infer the repository from `git remote -v`.

## Conventions

- Create an issue: `gh issue create --title "..." --body-file -` with a heredoc for a multi-line body.
- Read an issue: `gh issue view <number> --comments` and fetch its labels and relationships when they affect eligibility.
- List issues: `gh issue list --state open --json number,title,body,labels,comments` with the relevant label and state filters.
- Comment on an issue: `gh issue comment <number> --body-file -`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue: add its evidence-backed resolution comment, then run `gh issue close <number>`.

## Pull requests as a triage surface

PRs as a request surface: no.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## Skill operations

When a skill says "publish to the issue tracker," create a GitHub issue.

When a skill says "fetch the relevant ticket," read its body, labels, comments, parent, and open blockers.

## Wayfinding and ticket graphs

- A wayfinder map is one issue labelled `wayfinder:map` with decision tickets as native sub-issues.
- Use native issue dependencies for blocker relationships. Use the body convention only if the repository cannot represent a native edge.
- The frontier is the map or specification's open, unblocked, and unclaimed children in tracker order.
- Claim a frontier ticket by assigning it to the current owner before any other write.
- Resolve a ticket by publishing its evidence-backed answer, closing it, and adding a concise pointer to its parent.
- Preserve the parent and blocker graph when specifications become implementation tickets.

## Claims and completion

An assignee is the visible tracker claim. Hanoon's leased internal claim is the execution claim. Both must refer to the same work artifact.

A closed issue is collaboration state, not delivery proof. Hanoon closes implementation work only after its acceptance and integration evidence is durable, and closes the root effort only after its required release evidence is durable.
