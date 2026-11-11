---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A connector seed that failed now retries on the next command, under the seed locks, instead of refusing every command until `cotal ext seed --repair` is run. Once the cause is fixed, such as npm back on PATH, the next command installs the connector with no `--repair`. A seed that still fails reports its reason again. `cotal ext seed --repair` still works.
