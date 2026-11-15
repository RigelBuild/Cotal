---
"@cotal-ai/cli": patch
---

`up --no-manager` now classifies a pending maintenance refusal and reports it in `status --json`.

Plain-mode exit changes from 1 to 2, and `--json` changes from `OPERATION_UNKNOWN` to `LIFECYCLE_BLOCKED`. The refusal names the root, uses `maintenanceNextStep` when available, and names the journal state when it has no next step; it does not claim bare `cotal up` advances a cut-intent journal. `status --json` adds `result.maintenance.noManagerRefused`, false with no journal or an admitted active restore. Pending `up --rotate-sys` is also classified as `LIFECYCLE_BLOCKED`.
