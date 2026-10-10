---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Keep a presence condition raised while a turn start awaits the mesh link. The turn-start clear now skips when a newer condition write landed, so a Codex approval raised on the same tick as `turn/started` is no longer erased. `CotalEndpoint.conditionWrites` exposes the endpoint's condition revision.
