---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
"cotal-ai": patch
---

Add a spawn allowlist. `cotal supervise --spawn-allowlist <path>` loads a JSON list of the exact names the manager may launch. Spawns, crash-recovery restarts and resumes of any other name are refused, including an auto-numbered `reviewer_2` from a listed `reviewer`. The new admin command `allowlist-set` (`cotal allowlist set <name>...`) replaces the list and rewrites its file. It returns only after every in-flight launch of a removed name has settled, so a `cotal stop` run after it finds any seat such a launch started.

Without `--on`, allowlist-set refuses when manager status is ambiguous: multiple instances are not confirmed gone, any reachable instance refuses its status read, or a silent instance is not confirmed gone. Bearer callers keep their issuer-selected manager route without a class scatter.
