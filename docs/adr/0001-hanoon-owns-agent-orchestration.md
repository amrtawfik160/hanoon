# Hanoon owns agent orchestration

Hanoon's generation-fenced executor owns agent fan-out, worktrees, retries, publishing, and durable stage transitions. Skills may guide reasoning inside an assigned attempt, but they may not create a second orchestration control plane; this preserves Hanoon's receipts, recovery, approval boundaries, and duplicate-suppression at the cost of adapting useful nested-agent workflows into explicit Hanoon stages.
