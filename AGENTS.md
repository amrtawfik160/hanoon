# Development Workflow

Use the smallest safe workflow for each task

Do not duplicate brainstorming, specifications, plans, reviews, documentation, or subagent work

## Agent skills

### Issue tracker

Issues, specifications, and tickets use GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Agent readiness uses the canonical Matt Pocock triage roles. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Workflow routing

### Direct changes

For copy, styling, configuration, and clear mechanical changes:

- Do not use grill-with-docs
- Skip specifications, plans, worktrees, and subagents
- Implement directly
- Run the smallest relevant verification
- Do not commit unless requested

### Bounded features

For clear changes to an existing flow:

- Use the Superpowers bounded path
- Present a short design in chat
- Do not create specification or plan documents
- Implement inline after approval
- Run targeted verification
- Perform one final review

### Unclear features

When product behavior, terminology, or important decisions are unclear:

- Suggest /grill-with-docs
- Never invoke it automatically
- Run it in the main conversation, not inside a subagent or orchestration workflow
- Confirm that grill-with-docs, grilling, and domain-modeling are loaded
- Stop when remaining questions would not materially change the result

### Architectural work

Use the full Superpowers workflow only for:

- New systems or major architectural changes
- Public API or schema changes
- Authentication, billing, security, migrations, or concurrency
- High-risk or multi-session work
- Work explicitly requested as autonomous

## Combining grill-with-docs and Superpowers

After a completed grilling session:

- Stay in the same conversation
- Summarize the resolved requirements and ask for confirmation
- Treat confirmation as design approval
- Skip Superpowers brainstorming
- Do not repeat the interview
- Do not create competing specification documents

For bounded work:

- Implement directly from the grilling conversation
- Do not create a specification or implementation plan

For architectural work:

- Synthesize one specification from the grilling conversation
- Review it once
- Continue with Superpowers writing-plans
- Default to inline execution

Use subagent-driven development only for genuinely independent tasks, unattended execution, or high-risk work

## Documentation

- Keep CONTEXT.md limited to domain terminology
- Create ADRs only for difficult-to-reverse, surprising decisions involving real tradeoffs
- Do not create documentation merely to prove a workflow ran
- Before leaving a grilling session, preserve important requirements in a specification or implementation handoff

## Verification

Use tests for logic, state, data, authentication, billing, persistence, regressions, and public contracts

For styling, copy, documentation, and configuration, use the relevant build, lint, typecheck, screenshot, or focused check

Do not create low-value tests solely to satisfy a process

## Git

- Do not create worktrees for direct or bounded work
- Use worktrees for parallel, architectural, or multi-session work when useful
- Do not commit, push, merge, or create a pull request unless requested

## Models

- Use a strong model for grilling, architecture, and high-risk review
- Use a standard model for integration and debugging
- Use a lower-cost model for clear mechanical implementation
- Always select subagent models explicitly
