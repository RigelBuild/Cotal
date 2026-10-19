---
"@cotal-ai/pi": patch
"@cotal-ai/connector-core": patch
---

Pi drops retained Cotal batches without acknowledging them when the seat switches to a different session, so the new session receives them again and a held seat recovers. Run turns those batches surfaced are released through the new `MeshAgent.releaseSurfacedTurns`, so the new session is shown them again before any automatic `done`.
