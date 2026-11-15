# Released schemasafe comparison

`pnpm smoke:schema-remaining15-schemasafe-comparison` runs the public `@exodus/schemasafe` 1.3.0 validator with one frozen spec-mode configuration against the unchanged PR3780 corpus. It registers 50 callbacks: one census, fifteen official witnesses, thirty-three paired controls and one authored-ID/retrieval-alias pointer control. The full-path maximum is 246 assertions, not an observed count. The original 197-test Ajv diagnostic and its eight captures stay unchanged.

Each callback records starts, completion, phase, actual verdict when obtained and attempted assertions, then rethrows every failure. Compile exceptions are not false verdicts or expected passes. Native TAP, exit status and the terminal census must agree. This first comparison adds no candidate generated-code captures. The public entry, package version/hash, test/corpus hashes, hosted source-head assertion and Node/V8 versions are reported. CI must independently join the actual checkout, frozen installation and published package integrity to that provenance.

The exact dependency and zero-dependency lock entries are declarative source edits from retained registry metadata. No package-manager lock generation or installation is claimed. The existing Linux unit job uses `pnpm install --frozen-lockfile`; execution must verify the lock and loaded release before accepting results. No local execution has occurred.

This measures direct-engine outcomes only. Spec mode is a diagnostic setting, not a production profile change. Standalone precompiled browser modules do not establish runtime compilation of arbitrary fetched contracts under CSP. No engine adoption, browser acceptance, `compileContract` conformance, product error adaptation or repair is established.
