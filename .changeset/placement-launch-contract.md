---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Add the placement-only launch contract: the `prepare-launch` and `place` manager commands, the closed `Placement`, `ExecutionAuthority`, `ExecutionGate` and `LaunchIntent` records, and the `buildAcceptIntentRequest` builder. The commands are served behind the reconciler principal, which is not built yet, so they refuse until it lands. The manager cluster revision advances to 53.
