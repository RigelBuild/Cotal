---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Add `cotal spawn --continue <id>` to reopen an existing session in place. The flag is mutually exclusive with `--resume`, which continues to fork, and detached launches retain the exact session id for manager recovery.
