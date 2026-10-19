---
"@cotal-ai/connector-core": patch
---

A launch that grants no capabilities now says so: `COTAL_CAPABILITIES` is set to an empty value, and the session uses it instead of falling back to the persona file's `capabilities:`. An absent value still defers to the persona.
