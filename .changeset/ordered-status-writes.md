---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-codex": patch
---

Publish a seat's status changes in the order the host made them. An `idle` sent while a `working` write was still clearing its condition could publish first and be overwritten, which left the roster showing `working` after the turn ended and skipped the turn's automatic `done`. The Codex event plane now waits for the mesh link before it starts, so a resumed seat no longer stops its emitter with "endpoint not started".
