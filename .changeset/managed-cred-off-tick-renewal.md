---
"@cotal-ai/manager": patch
---

The manager now re-signs managed agent credentials at 37.5% of their lifetime, between TTL/4 pass ticks. This keeps re-signing ahead of the endpoint's 75% credential re-read; previously the manager waited until that re-read boundary, causing repeated refresh warnings and a possible missed pass until expiry.
