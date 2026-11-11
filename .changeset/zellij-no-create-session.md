---
"@cotal-ai/zellij": patch
---

Add `COTAL_ZELLIJ_NO_CREATE_SESSION=1`. With it set, the zellij runtime never creates its session. `cotal up` leaves a missing session alone, and a spawn into a missing session is refused with `SpawnRefused`. Use it when another process, such as a server you start yourself, owns the session.
