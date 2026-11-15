---
"@cotal-ai/cli": patch
---

`cotal up --detach` prints `• started nats-server (pid N)` as soon as the broker spawns, before it waits for readiness. A caller that must stop only the broker it started can read that pid, even when the start later fails and the summary never prints.
