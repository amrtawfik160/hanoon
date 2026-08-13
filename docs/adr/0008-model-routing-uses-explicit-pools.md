# Model routing uses explicit pools

Hanoon routes work through explicitly configured `strong`, `standard`, and `fast` model pools using recipe, stage, risk, and observed complexity. A worker cannot select its model, equivalent failures escalate after two attempts, no retry silently downgrades or inherits an unknown default, and candidate routes remain shadow-only until evaluated. This requires more configuration and routing evidence, but removes hard-coded stage models and makes quality, latency, cost, and fallback decisions auditable.
