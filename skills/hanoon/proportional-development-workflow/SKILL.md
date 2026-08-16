---
name: proportional-development-workflow
description: Use when choosing how much development process a software change needs, especially when deciding between direct work, Superpowers, or a user-requested grilling session.
---

# Proportional Development Workflow

Use the smallest safe workflow. Do not duplicate interviews, brainstorming, specifications, plans, reviews, documentation, or subagent work. User instructions and an immutable Hanoon work order outrank this routing guidance.

## Route the task

| Situation | Workflow |
| --- | --- |
| Copy, styling, configuration, or a clear mechanical change | Implement directly; use neither grilling nor Superpowers planning |
| Clear change to an existing flow | Use the Superpowers bounded path: short in-chat design, approval, inline implementation, targeted verification, one final review |
| Important product behavior, terminology, or decisions are unclear | Suggest `/grill-with-docs`; never invoke it automatically |
| New system, public contract, auth, billing, security, migration, concurrency, high-risk, multi-session, or autonomous work | Use the full Superpowers architectural workflow |
| Reproducible bug with clear expected behavior | Use Superpowers systematic debugging; grill only if product behavior is unclear |

## Use grilling as a separate gear

When the user invokes `/grill-with-docs`:

- Run it in the main conversation, never inside a subagent or orchestration pipeline.
- Confirm `grill-with-docs`, `grilling`, and `domain-modeling` are loaded and the repository is safe to modify.
- Investigate repository facts; ask only questions that represent meaningful user decisions.
- Keep `CONTEXT.md` to domain terminology. Create an ADR only for a difficult-to-reverse, surprising decision with a real tradeoff.
- Summarize resolved behavior, constraints, exclusions, defaults, and verification criteria, then ask for confirmation.

After confirmation, stay in the same conversation and treat it as design approval. Skip Superpowers brainstorming and do not repeat the interview. For bounded work, implement directly without a spec or plan document. For architectural work, synthesize one specification, review it once, then use Superpowers writing-plans with inline execution by default.

## Defaults

- Use tests for logic, state, data, authentication, billing, persistence, regressions, and public contracts.
- For copy, styling, documentation, and configuration, use the relevant build, lint, typecheck, screenshot, or focused check.
- Do not create a worktree for direct or bounded work. Do not commit, push, merge, or open a pull request unless requested or required by an approved Hanoon job.
- Use a strong model for grilling, architecture, and high-risk review; a standard model for integration and debugging; and a lower-cost model for complete mechanical work. Always select subagent models explicitly.
- Use subagent-driven development only for genuinely independent tasks, unattended execution, or high-risk work.

## Common mistakes

- Running grilling automatically
- Starting Superpowers brainstorming after grilling
- Creating competing specifications or reviews
- Adding process after a durable Hanoon job already selected it
- Writing low-value tests only to satisfy a ritual
