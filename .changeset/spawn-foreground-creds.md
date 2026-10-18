---
"@cotal-ai/cli": patch
---

`cotal spawn --creds <file> --lifecycle-uid <uid>` now launches a foreground agent from a pre-minted credential. The launching host needs no trust material: it mints nothing, provisions nothing, and leaves the operator's file in place. The session's capabilities come from the credential's own grants. The uid must be the one minted with the credential (`COTAL_LIFECYCLE_UID` also works); a missing or mismatched uid is refused before launch. `--creds --detach` is unchanged.
