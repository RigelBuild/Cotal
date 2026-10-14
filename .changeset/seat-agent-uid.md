---
"@cotal-ai/seat": minor
---

Seats can run under a distinct agent uid. `launchSeat({ agentUid })` needs a launcher with euid 0: it chowns the seat directory to that uid and spawns the custodian with its uid and primary gid, and no supplementary groups. The primary gid comes from `/etc/passwd`, or from `COTAL_SEAT_AGENT_GID` for a uid not listed there. The custodian answers only connections from the launcher's uid (`CustodianLaunch.adopterUid`), and it checks this on every frame, so the agent cannot stop or drive its own seat. `resolveCgroupBase()` returns this process's own cgroup when it is on cgroup v2 and this euid can write its directory, `cgroup.procs` and `cgroup.subtree_control`; it runs no program to decide.

The seat directory is agent-owned, so the launcher writes `launch.json` exclusive and no-follow before the chown, and reads `record.json` and `custodian.log` no-follow. `loadSeat` refuses a record that names another seat and derives the socket from the root and id. The containment migration probe runs `setpriv` only from fixed system paths, with `--clear-groups`; with no `setpriv`, a seat is not contained.
