---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Agent credentials read the roster through `auth.roster` in user-auth meshes and `manager.roster` in static meshes. The agent profile no longer grants raw presence reads or watches. The auth cluster document is revision 3 and the manager document is revision 52.

Upgrade the auth service before user-auth agents, and the manager before static agents. Roster reads fail closed if the serving endpoint is unavailable.
