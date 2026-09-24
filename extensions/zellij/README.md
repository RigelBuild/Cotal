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

Set `COTAL_ZELLIJ_SESSION` to target a shared Zellij session instead of the session passed by Cotal. The runtime creates the selected session detached if it does not exist. Attach with `zellij attach <session>`.
