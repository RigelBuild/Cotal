---
"@cotal-ai/connector-hermes": minor
---

`gateway.platforms.cotal.single_session: true` runs all mesh traffic in one Hermes session. Replies go to the origin of the message they answer, and a message that arrives mid-turn waits for the turn to end.

The bridge now holds each pushed delivery in flight until the adapter reports it, so a delivery held behind a long turn is not redelivered by the broker.
