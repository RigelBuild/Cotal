---
"@cotal-ai/auth": minor
---

Serve the four placement participant operations (`verify-placement-enrollment`, `enrollment-effect-status`, `close-enrollment-effect`, `retire-placement-enrollment`) as untargeted commands on the auth endpoint. The transport principal is the broker-authenticated caller, mapped by the injected `ServiceAuthenticator`; only the configured reconciler is admitted, and an unconfigured authenticator refuses every operation. The auth cluster document is revision 2.
