---
"@cotal-ai/manager": patch
"cotal-ai": patch
"@cotal-ai/seat": patch
---

The manager now treats a seat it cannot prove gone as fail-closed. A retained reap keeps the static slot in `terminalizing` and keeps the seat's credentials, durables and ACL row. Status reports the item as `refused` with a `retainedReason` and a release remedy, and counts it in `staticReconciliation.retainedCustody`. A failed custody reservation is fatal before spawn. A restart or resume must prove its predecessor gone before it records a new reference. A spawn under an unexpected reference records that reference so the terminal reaps it. `cotal status` renders the retained count and reason. The seat custodian gains a test seam that makes the delayed SIGKILL fail.
