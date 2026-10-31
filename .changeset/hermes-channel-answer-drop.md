---
"@cotal-ai/connector-hermes": patch
---

`channel_replies: false` with `single_session: true` now also drops a turn's reply when the turn answers a question asked in a channel turn. That reply used to be published to the channel as a plain post.
