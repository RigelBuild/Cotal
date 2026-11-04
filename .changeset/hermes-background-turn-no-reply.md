---
"@cotal-ai/connector-hermes": patch
---

In single-session mode, a turn no peer message started (a background-process completion) no longer sends its reply to the shared chat's last sender. The reply is dropped. To report the result, the agent calls `cotal_dm`.
