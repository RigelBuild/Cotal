---
"@cotal-ai/pi": patch
---

A Pi seat no longer stays held forever after a run ends with a Cotal steer still unconfirmed. Once Pi is idle with nothing queued, the lost batch is dispatched again from the inbox; nothing is acknowledged before a turn confirms it. While delivery is held, the seat's presence activity keeps naming the hold during tool runs.
