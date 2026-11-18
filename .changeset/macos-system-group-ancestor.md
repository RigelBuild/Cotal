---
"@cotal-ai/workspace": patch
---

On macOS, accept a root-owned ancestor in group daemon, such as /private/var/run, so sops-nix credentials under it are no longer refused as not owned by you.
