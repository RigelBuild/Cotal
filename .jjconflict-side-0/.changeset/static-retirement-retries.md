---
"@cotal-ai/manager": patch
---

Retry ordinary live static-seat retirement failures after 1s, 5s and 30s. The alias stays held on failure or exhaustion, and retries stop when the durable lifecycle identity changes.
