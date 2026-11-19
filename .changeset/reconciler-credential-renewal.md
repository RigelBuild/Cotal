---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

The reconciler credential is issued and renewed by the auth service, not by the reconciler. Auth renews it at 75% of its lifetime and writes it to one Kubernetes Secret, enabled with `--reconciler-secret <namespace/name>` or the matching `runAuthService` option. The caller owner is now the platform control owner for the space's account, not a derived user owner. Core exports `armFixedRenewal` and `fixedRenewalPointMs`. Auth exports `KubeSecretStore`, `startReconcilerCredential`, and the record store helpers.
