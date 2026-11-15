---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Manager registration reads return a nonce-bound absent result for an exact missing gate read. The auth-owned responder sends typed refusals for gate and key authorization failures, and plain failures for other errors.
