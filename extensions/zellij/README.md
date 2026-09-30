# @cotal-ai/zellij

Select the runtime with `cotal up --runtime zellij`. Each agent gets a separate tab by default.

Add a placement block to an agent persona to share a named tab:

```yaml
---
zellij:
  tab: platform
  stacked: true
---
```

Tabs are created on demand. The optional pane shape is `stacked: true`, `floating: true`, or `direction: right|down`; a tab with no shape defaults to stacked panes.

Zellij tabs keep their assigned names. Zellij ignores OSC titles from panes it starts with a command, so an agent that joins an existing tab gets a plain shell pane and Cotal types `cd <dir> && exec ./<agent>` into it. The launcher script is named after its agent and sets that name as the first title; the agent then sets its own title and spinner. The launch payload is stored in a private temporary file and removed before the agent starts. Pressing Enter on the exited pane prints a message to respawn the agent through Cotal.

Set `COTAL_ZELLIJ_SESSION` to target a shared Zellij session instead of the session passed by Cotal. The runtime creates the selected session detached if it does not exist. Attach with `zellij attach <session>`.
