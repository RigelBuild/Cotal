---
"@cotal-ai/reconciler-shim": patch
---

Add the reconciler shim. It serves the `wave-seats` commands on an authorized serve bundle and forwards each validated call to the Go reconciler over a Unix socket. A reconciler error code passes through unchanged; an unreachable socket, a malformed or oversized reply, or a missed deadline is `unavailable`.
