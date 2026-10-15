---
"@cotal-ai/seat": minor
---

A seat launched under a distinct agent uid now starts through the trusted `setpriv` with `--no-new-privs` and `--bounding-set=-all`, so neither the custodian nor the agent can ever gain a capability such as `CAP_DAC_OVERRIDE`. `seatCgroupContained` also checks every process in the seat cgroup and its nested cgroups. Containment holds only when each one has `NoNewPrivs: 1` and an empty `CapBnd`. Without a trusted `setpriv`, `launchSeat` refuses a distinct agent uid. A member that cannot be read, or a cgroup that vanishes mid-check, reads as not contained, so a reap stays `retained`.
