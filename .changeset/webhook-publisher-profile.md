---
"@cotal-ai/core": minor
---

Add the `webhook-publisher` credential profile for integration publishers: it can publish DMs and anycast as itself and read live presence, with no fetch, ack, chat, control, or stream-delete rights. Export `JETSTREAM_PUBLISH_TIMEOUT_MS`, the JetStream client's publish timeout, which the DM and TASK duplicate window must cover.
