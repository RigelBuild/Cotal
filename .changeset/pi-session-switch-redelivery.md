---
"@cotal-ai/pi": patch
---

Pi drops retained Cotal batches without acknowledging them when the seat switches to a different session, so the new session receives them again and a held seat recovers.
