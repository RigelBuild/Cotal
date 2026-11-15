---
"@cotal-ai/connector-hermes": minor
---

`gateway.platforms.cotal.peer_silence: true` marks every peer message as not needing a reply. A bare silence marker then stays silent. Without it, Hermes replaces the marker with an error notice and sends that to the mesh.
