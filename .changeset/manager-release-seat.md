---
"@cotal-ai/manager": patch
"@cotal-ai/seat": patch
"@cotal-ai/core": patch
"cotal-ai": patch
---

Add the `release-seat` admin command. An operator attests that a retained seat's processes are gone. The manager seals the launch fence, records the release, removes the seat directory and completes the lifecycle terminal, which frees the alias. It never sends a signal. A retry of an eviction audit now compares identity fields only, so a successor manager or a re-kick of 0 no longer wedges the terminal.
