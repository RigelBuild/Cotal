---
"@cotal-ai/auth": minor
---

Adds the placement reconciler authenticator. It admits only the auth identity's reconciler key, derived from the owner secret and space, and refuses every other key. No flag or manifest field sets it. Placement stays unimplemented until its reconciler and role-policy ports are wired.
