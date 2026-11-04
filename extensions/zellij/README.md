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

Tabs are created on demand. The optional pane shape is `stacked: true`, `floating: true`, or `direction: right|down`; a tab with no shape defaults to stacked panes. Zellij 0.45 can report a pane ID for a shaped pane and then fail to add it, for example "Failed to add pane to stack". When the new pane is missing from the tab, the agent is placed in an unshaped pane instead.

Zellij tabs keep their assigned names. Zellij ignores OSC titles from panes it starts with a command, so an agent that joins an existing tab gets a plain shell pane and Cotal types `cd <dir> && exec ./<agent>` into it. The launcher script is named after its agent and sets that name as the first title; the agent then sets its own title and spinner. The launch payload is stored in a private temporary file and removed before the agent starts. An agent's pane closes when the agent exits, and a tab created for the agent closes with it; respawn the agent through Cotal. Because the pane closes, the launcher also writes a failed start or a non-zero exit to its private directory, and the runtime logs that reason when it sees the exit.

Each seat's exit is watched through one held `zellij subscribe` process, not by listing panes. A `list-panes` call connects a client, and its disconnect sends the full pane manifest to every plugin that subscribes to pane updates. When the stream ends, one listing confirms the exit; a pane that is still running is subscribed again with backoff. The subscribers are killed when the Cotal process exits.

Set `COTAL_ZELLIJ_SESSION` to target a shared Zellij session instead of the session passed by Cotal. The runtime creates the selected session detached if it does not exist. Attach with `zellij attach <session>`.
