---
"@cotal-ai/seat": minor
---

Seats can run in a per-seat cgroup v2 domain. `launchSeat({ cgroupBase })` creates `<base>/seat-<id>` and moves the custodian into it, and the custodian starts no child until it is inside. `reapSeat({ cgroup })` kills that cgroup and returns `reaped` only when the cgroup is contained (the agent uid cannot migrate out of it) and is empty and removed. A release refuses while the seat cgroup is populated and removes an empty one under the launch fence lock.
