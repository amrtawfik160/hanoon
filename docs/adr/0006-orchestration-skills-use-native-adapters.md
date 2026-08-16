# Orchestration skills use native adapters

Hanoon represents orchestration-oriented skills as versioned native recipe adapters rather than injecting their raw instructions into workers. Each adapter names the source skill and bundle digest, preserves tested invariants, documents replaced mechanics, and emits receipts labeled `hanoon-native`; it never claims the raw skill ran. This requires adapter-specific conformance tests, but avoids competing worktree, subagent, review, publishing, and branch authorities inside one job.
