---
"@cotal-ai/cli": patch
---

`cotal mint` now forwards capabilities from the agent file. Re-minting with `--identity` preserves the lifecycle UID by default; `--new-incarnation` opts into a fresh UID.
