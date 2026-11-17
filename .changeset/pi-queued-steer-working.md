---
"@cotal-ai/pi": patch
---

A DM steered into a busy Pi session that Pi has not started within 5 s shows the seat as working with `steer queued`, not waiting. The batch is still held until Pi starts it, and an idle steer Pi never starts is re-dispatched from the inbox after the lost-steer settle window.
