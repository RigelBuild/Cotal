---
"@cotal-ai/cli": patch
---

`cotal mint` now validates agent-file capabilities against the manager's shared allowlist before signing. It refuses unknown capabilities and rejects `--new-incarnation` outside the agent profile. Missing mint names and agent re-mints without exactly one lifecycle UID are refused before writing credentials.
