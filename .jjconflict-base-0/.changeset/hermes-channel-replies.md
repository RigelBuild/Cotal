---
"@cotal-ai/connector-hermes": minor
---

`gateway.platforms.cotal.channel_replies: false` stops posting a turn's reply to a channel. The agent then posts in a channel only through `cotal_send`, and each channel message tells it so. DM replies are unchanged.
