---
"@cotal-ai/connector-hermes": patch
---

The Hermes bridge socket no longer fails to launch when the per-user temp directory is long. macOS's `TMPDIR` (`/var/folders/…/T/`) alone overran darwin's 104-byte `sun_path` limit, so the launcher refused with "bridge socket path is 106 bytes". The socket now falls back to `/tmp` when the temp directory is too long. Its name still carries the launch's control token.
