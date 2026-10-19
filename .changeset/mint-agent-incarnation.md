---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
---

`cotal mint` now forwards the agent file's capabilities, so a minted credential can carry `spawn`. A re-mint with `--identity` keeps the lifecycle UID by default, so existing DM, delivery and history durables stay bound; `--new-incarnation` (agent profile only) mints a fresh UID instead. Capabilities are checked against the allowlist the manager uses, `admin` and unknown values are refused before signing, and `@cotal-ai/core` exports that check as `assertKnownAgentCapabilities`.
