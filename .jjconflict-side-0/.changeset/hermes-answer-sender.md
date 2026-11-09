---
"@cotal-ai/connector-hermes": patch
---

An answer to a question asked from a Cotal DM session (including the `single_session` chat) now runs with the answering peer as its sender. It used to take the asking turn's sender, so a peer's answer to a question asked during another peer's turn was attributed to that other peer.
