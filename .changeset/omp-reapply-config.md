---
"@cotal-ai/omp": patch
---

The omp connector accepts a `reapplyConfig` launch option. Set it to `"true"` and a resumed or continued session starts with `--reapply-config`, so the `config` overlay's default model and thinking level replace the session's own. A fresh spawn ignores it, and any value other than `"true"` or `"false"` is refused.
