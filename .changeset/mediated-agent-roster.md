---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Authenticated agents read the roster through `auth.roster` in user-auth meshes and `manager.roster` in static and token-authenticated meshes. Open-mode agents retain direct reads. Static managers use a dedicated read-only reader; token-mode managers serve from their existing presence watch cache. The agent profile has no raw presence reads or watches and retains its own-key write and presence `STREAM.INFO`. The auth cluster document is revision 3 and the manager document is revision 52.

Upgrade the auth service before user-auth agents, and the manager before static or token-authenticated agents. Roster reads fail closed if the serving endpoint is unavailable.
