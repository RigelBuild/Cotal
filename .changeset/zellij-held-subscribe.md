---
"@cotal-ai/zellij": patch
---

Watch each seat's exit through one held `zellij subscribe` instead of polling `list-panes`, which made every pane-update plugin queue a full pane manifest per call. Tabs created for an agent now close when the agent exits.
