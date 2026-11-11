---
"@cotal-ai/zellij": patch
---

Add a Darwin branch to the holder runtime. Seat identity now comes from `wave-host process-identity --pid N`, which reports the process start token as integer microseconds, instead of `/proc`. Seat stop now runs `wave-host seat-stop --name NAME`, instead of `systemctl --user`. The Linux `/proc` and `systemctl` paths are unchanged. `WAVE_HOST_COMMAND` names the Darwin wave-host executable.
