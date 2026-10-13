---
"@cotal-ai/seat": patch
---

The seat custodian now pins its PTY child with a pidfd from a vendored, patched `node-pty@1.2.0-beta.12` build and sends every signal through that pidfd, so a reused pid is never signalled. A launch admits through a per-seat fence, the custodian no longer recreates a removed seat directory, every startup failure after pinning stops the child, and a settled seat keeps its `record.json`. `@lydell/node-pty` is no longer a seat dependency. The shipped `pty.node` raises the minimum glibc to 2.34 (Linux 5.3 for the pidfd).
