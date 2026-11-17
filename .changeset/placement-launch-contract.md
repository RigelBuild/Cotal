---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Add the placement-only launch contract: the `prepare-launch` and `place` manager commands, the closed `Placement`, `ExecutionAuthority`, `ExecutionGate` and `LaunchIntent` records, and the `buildAcceptIntentRequest` builder. Both commands refuse `unimplemented` until a reconciler port is configured; no reconciler principal check exists yet. The manager cluster revision advances to 53.
