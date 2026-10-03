---
"@cotal-ai/zellij": patch
---

The zellij package smoke now exercises the shared destructive sandbox guard in a recorded temporary root. Its smoke package declares the guard helper as a development dependency.