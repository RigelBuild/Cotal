# Remaining schema diagnostics

This broker-free diagnostic runs the pinned Ajv 8.20.0 public 2020-12 entry through the standard Node test runner. It differs from the maintained upstream Mocha harness. It does not call `compileContract` or establish its conformance, profile bounds, branding, error compatibility or browser acceptance.

From the core package directory:

```sh
node --test --test-concurrency=1 smoke/schema-remaining15-diagnostic.test.mjs
```

The 197 tests comprise one corpus census and four configurations, each with fifteen retained official witnesses, thirty-three independent controls and one authored-ID/retrieval-alias pointer test. The official witnesses come from JSON-Schema-Test-Suite revision `7de0e6a06031ede80028583dd45d0cd41105ae5b`. Input bytes, options and predicate assertions are preserved from the upstream-oriented diagnostic. The runner adds test registration, counter instrumentation and native evidence capture.

Every synchronous exception is recorded and rethrown. The terminal JSON reports observed test starts, completions, passes, failures and assertion attempts, including per-test rows. A valid census requires `complete: true`, 197 started and ended tests, matching totals and the native runner output and exit status. Suite-container totals are separate from the 197 test callbacks. Missing output, import failures, incomplete execution and hook errors are setup failures or unknown results, never a successful diagnostic.

For `shipped-pin` rows `M09`, `M10`, `M09-C2`, `M09-C3`, `M10-C1`, `M19`, `M20` and `M19-C2`, the runner captures native evidence immediately after validation, before the final verdict assertion. The terminal JSON includes the actual boolean, detached native errors and evaluated metadata with presence flags, effective option values and the generated validator body with UTF-8 size and SHA-256. Snapshot values encode native `undefined` as `{ "diagnosticValue": "undefined" }`. These are diagnostic snapshots, not replacement validator fields or a generated-code oracle.

Captures refuse explicitly above 16 KiB per native snapshot, 64 KiB per validator body, 128 KiB per serialized row or 512 KiB for all serialized capture rows. Refusals and serialization errors are recorded and rethrown. Evidence is never silently truncated. A complete test census alone does not prove all eight captures were obtained. Consumers must verify the eight row IDs, body sizes and hashes as well as native test outcomes.

Known wrong verdicts remain failing tests. No TODO, skip, expected-failure conversion or exit masking is used. Assertion counts are measured, not inferred from the theoretical maximum of 975. The four configurations are diagnostic controls, not proposed changes to the shipped compiler options. The original hosted diagnostic measured 197 tests, 65 passes and 132 failures with exit 1. Execution of the native-capture successor is pending. The fifteen unresolved cases, adjacent `__proto__` schema filter and browser acceptance remain outside the five-case own-member repair.
