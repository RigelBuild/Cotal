---
"@cotal-ai/workspace": patch
---

Map `allowlistSet` and `attestGone` to their registered manager commands. Manager operation names are type-checked against `EP_COMMANDS`, and a CI smoke checks every mapping against the manager's shipped command surface.
