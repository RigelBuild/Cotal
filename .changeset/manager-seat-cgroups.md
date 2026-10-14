---
"@cotal-ai/manager": minor
---

The Linux pty runtime puts every seat in its own cgroup when the manager runs in a delegated cgroup (`systemd-run --scope -p Delegate=yes`). Reap, release check and release seal pass that cgroup, so a contained seat reaps as proven gone. When no delegated cgroup is available the manager logs one line, and reaps of live seats stay retained. `COTAL_SEAT_AGENT_UID` runs seats under a distinct uid, which needs a manager with euid 0. The manager chowns each incarnation's creds file to that uid, at spawn and at every renewal, and gives its parent directories traverse-only access.
