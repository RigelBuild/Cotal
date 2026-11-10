---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Confine remote manager registration reads and family enumeration to auth-owned operations.

Remote managers can read their own retired gate to report the registration refusal. Executor renewal validates the current registration proof against the same gate checked during minting.

Manager selection recognizes current manager activity when displaying the runtime. A JSON stop receipt is no longer followed by human-readable text.
