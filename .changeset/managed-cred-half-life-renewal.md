---
"@cotal-ai/manager": patch
---

The manager now re-signs a managed agent's credential once it is past half its lifetime. It used to wait until 75%, the same point where the agent starts re-reading its credential file. With a 6h pass on a 24h credential, agents logged "creds refresh failed" every minute for up to 6 hours. A pass landing just before the 75% point could also push the re-sign out to the credential's expiry.
