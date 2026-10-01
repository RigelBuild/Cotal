---
"@cotal-ai/zellij": patch
---

An agent that joins an existing tab no longer fails to start when zellij reports a pane ID for a stacked or directed pane and then drops it. The runtime checks that the pane exists and falls back to an unshaped pane.
