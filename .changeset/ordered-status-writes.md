---
"@cotal-ai/connector-core": patch
---

Publish a seat's status changes in the order the host made them. An `idle` sent while a `working` write was still clearing its condition could publish first and be overwritten, which left the roster showing `working` after the turn ended and skipped the turn's automatic `done`.
