---
"@cotal-ai/manager": minor
---

The Linux pty runtime puts every seat in its own cgroup when the manager runs in a delegated cgroup (`systemd-run --scope -p Delegate=yes`). Reap, release check and release seal pass that cgroup, so a contained seat reaps as proven gone. When no delegated cgroup is available the manager logs one line, and reaps of live seats stay retained. A seat whose directory a different uid owns is reaped without its cgroup, so it stays retained.

`COTAL_SEAT_AGENT_UID` runs seats under a distinct uid, which needs a manager with euid 0. The runtime refuses at construction a custody root (`COTAL_SEAT_ROOT`, default `~/.cotal/seats`) that the agent uid cannot traverse. Before every static seat launch (spawn, renewal, resume and supervised restart) the manager keeps the creds file manager-owned, sets its group to the agent's primary gid and its mode to 0640, and gives each parent directory up to the workspace root group and other traverse (x) only. Every component is checked no-follow before the creds are written.
