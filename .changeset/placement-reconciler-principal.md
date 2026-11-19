---
"@cotal-ai/auth": minor
---

Adds the placement reconciler authenticator and its config: a `--reconciler-principal <owner.actor>` flag and a `reconcilerPrincipal` manifest field on `auth-service --spaces` entries. The authenticator admits only that exact key. Placement stays unimplemented until its reconciler and role-policy ports are wired.
