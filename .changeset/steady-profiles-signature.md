---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

The core API now exposes signed profile verification through `verifyStaticUserCredential`, including `requireProfile` and `allowOutOfWindow` options. Existing standalone endpoint-caller credentials without a signed profile marker must be re-minted with `cotal auth mint <name> --endpoint <endpoint> --out <private-file>`.
CLI commands `doctor auth`, `connect`, and `send` classify agent credentials only from a signed profile marker verified against trusted issuer pins. `whoami --creds` displays only that verified profile and labels the holder name unverified; permission, principal, and lifecycle claim fields remain decoded for diagnostic display and are not verified.
The `whoami --creds --json` `profile` field now means the verified signed profile and is `null` when no trusted marker is available; the JWT name is available separately as `nameUnverified`.
Unmarked or old-authority credentials do not supply trusted profiles or grants. For an exported or `--identity` agent credential, choose the intended profile and grants from a trusted source. Managed agents receive the marker on renewal. `send --creds` uses the credential's holder name only when trusted pins verify it; otherwise it uses the OS sender name.
The `PERMISSION_DENIED` message for `channel set`, `channel defaults`, `channel remove`, and `history clear` now says `this credential may not …` without naming a profile taken from the unverified JWT holder name.
