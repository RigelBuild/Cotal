---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A connector seed whose reconcile was killed while it spawned a seed child, for example by a service restart, now resumes on the next command. Before, every command, `cotal ext seed --repair` included, refused with "a connector seed may be mid-flight" until the marker was removed by hand. A seed child that finds its reconcile gone after writing its marker now refuses before installing anything. A corrupt marker still fails loud.
