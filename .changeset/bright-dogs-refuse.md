---
"@cotal-ai/cli": patch
---

`up --no-manager` now classifies a pending maintenance refusal and reports it in `status --json`.

Plain-mode exit changes from 1 to 2, and `--json` changes from `OPERATION_UNKNOWN` to `LIFECYCLE_BLOCKED`. The refusal names the root and the state-specific recovery step; cut-intent and cut-committed name `cotal down --preserve-state`, while a ready preserved cut resumes with bare `cotal up`. `status --json` adds `result.maintenance.noManagerRefused`, documented in `docs/cli-selection.mdx`. When no maintenance journal exists, `maintenance` remains `null`; consumers can read `maintenance?.noManagerRefused ?? false`. The flag is true when a maintenance journal exists but its stack journal cannot be read, and false for an admitted active restore. Pending `up --rotate-sys` is also classified as `LIFECYCLE_BLOCKED`.
