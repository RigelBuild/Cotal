---
"@cotal-ai/zellij": patch
---

The zellij runtime no longer polls `zellij action list-panes` for seat liveness. `status()` and `waitForExit()` now read the launcher's own pid and exit files. Polling every 100 ms per seat made the server send a full pane manifest to every plugin and grow without bound. A pane closed by hand is now noticed through the mesh heartbeat instead.
