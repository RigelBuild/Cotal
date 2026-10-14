---
"@cotal-ai/seat": minor
---

Seats can run under a distinct agent uid. `launchSeat({ agentUid })` needs a launcher with euid 0: it chowns the seat directory to that uid and spawns the custodian with its uid and gid. The custodian answers only connections from the launcher's uid (`CustodianLaunch.adopterUid`), and it checks this on every frame, so the agent cannot stop or drive its own seat. `resolveCgroupBase()` returns this process's own cgroup when it is a writable `Delegate=yes` unit on cgroup v2, and undefined otherwise.
