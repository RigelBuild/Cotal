---
"@cotal-ai/seat": minor
---

A seat launched under a distinct agent uid now starts through the trusted `setpriv` with `--no-new-privs` and `--bounding-set=-all`, so neither the custodian nor the agent can ever gain a capability such as `CAP_DAC_OVERRIDE`. `seatCgroupContained` also checks every process in the seat cgroup and its nested cgroups. Containment holds only when each one has `NoNewPrivs: 1` and an empty `CapBnd`. Without a trusted `setpriv`, the seat still launches but never reads as contained, so a reap stays `retained`.
