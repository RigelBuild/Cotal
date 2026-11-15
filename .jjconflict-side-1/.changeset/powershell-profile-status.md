---
"@cotal-ai/cli": patch
---

A `pwsh` current-user profile probe that fails, times out, or returns no usable profile path now warns without making bare completion partial when PowerShell is not the shell named by `SHELL`. When PowerShell is selected, the status remains partial.
