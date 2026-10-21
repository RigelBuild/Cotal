---
"@cotal-ai/pi": patch
"@cotal-ai/omp": patch
---

A DM steered into a busy Pi or OMP session no longer stops later DMs for the rest of the run. Pi consumes a mid-run steer at its next turn boundary. When a long tool call pushed that past the 5 s start watchdog, the driver held delivery until the run ended. Now, when Pi starts the batch the watchdog gave up on, that hold is released.
