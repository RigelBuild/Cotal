---
"@cotal-ai/zellij": patch
---

Agents that join an existing tab start in a shell pane, and Cotal types the launch line into it, so the agent's OSC title and spinner show. Zellij ignores OSC titles from panes it started with a command. The launcher script is named after the agent. `zellij.createPane` now takes a shell command line instead of an argv, and `buildNewPaneArgs` no longer takes an argv.
