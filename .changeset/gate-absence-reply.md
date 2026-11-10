---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Manager registration reads now return a nonce-bound absent result for a missing gate. The auth-owned responder also returns nonce-bound refusals, which clients handle as typed errors.
