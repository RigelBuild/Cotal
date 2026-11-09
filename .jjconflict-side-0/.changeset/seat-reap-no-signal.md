---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

Reaping a seat no longer signals any pid or process group named in its custody record. It only asks the custodian to stop through the seat's socket, and returns `retained` whenever it cannot prove the seat gone. The manager's pty runtime refuses a retained reap, so a seat that is not proved gone keeps its custody.
