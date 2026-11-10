---
"@cotal-ai/manager": patch
---
Close a seat's custody connection when its agent exits on its own, so the custodian can settle instead of staying resident for the life of the manager. When a successor cannot adopt a released seat, it now requires proof from the runtime reap before retiring that lifecycle and keeps the seat record until retirement succeeds, so an unproven lifecycle remains addressable on a later start.
