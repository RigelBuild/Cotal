---
"@cotal-ai/manager": patch
"@cotal-ai/core": patch
"cotal-ai": patch
---

Defer an unreachable static seat at manager boot until its credential has expired.

- An unadopted `active` or `provisioning` slot with credentials and no custody reference, on a runtime that cannot reap by reference, is now `deferred` with `deferUntil` (latest credential expiry plus 60 seconds). It is re-checked on each credential-renewal tick and at the next boot, and terminalizes once the credential has expired.
- `status` reports `staticReconciliation.deferredSeats`, and `cotal status` prints each item's `deferUntil` and `lastError`. A seat whose credential expiry cannot be read stays deferred with a remedy that says it will not terminalize on its own.
- `cotal stop --name <n> --attest-gone <reason>` terminalizes a deferred seat now through the new admin-only `attest-gone` command; the reason must be one line. A plain stop on a deferred seat prints the remedy.
