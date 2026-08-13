# One code writer owns a worktree

Hanoon allows only one code-writing lane in a managed worktree at a time. It may parallelize independent jobs, read-only investigations, and review lenses, while parallel code lanes remain unavailable until disjoint ownership, integration order, restart recovery, and conflict safety are proved by an equivalence suite. This gives up some theoretical throughput to preserve deterministic integration and the executor's single orchestration authority.
