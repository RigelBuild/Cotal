---
"@cotal-ai/zellij": minor
---

Make pane launches rerun-safe without persisting launch secrets after startup, and allow agent-set terminal titles on panes. Rename `PrivateLauncher.script` to `payload`, require an agent name for `privateLauncher`, and remove the pane `name` parameter from `zellij.createPane`.
