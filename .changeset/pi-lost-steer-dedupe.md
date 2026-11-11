---
"@cotal-ai/pi": patch
---

A lost Cotal steer that drains after its re-dispatch no longer reaches the model twice. The pi connector keeps the first copy of each receive key and run-turn text in the provider request, and drops or trims later copies.
