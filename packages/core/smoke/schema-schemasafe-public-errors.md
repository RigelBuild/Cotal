# Released schemasafe public-error diagnostic

`pnpm smoke:schema-schemasafe-public-errors` uses stock `node:test` and the existing released
1.3.0 public validator with the unchanged comparison options. Eight JSON fixtures each have a
valid and invalid callback: root, nested and referenced additionalProperties, escaped key,
multiple extra keys, patternProperties, an unevaluatedProperties branch and an ordinary type error.

The plan is 16 callbacks and at most 112 measured assertions, seven per completed callback:
public callable, lossless error snapshot, capture bound, boolean verdict, unchanged schema,
unchanged input and authored expected verdict. Failures are recorded and rethrown. Accounting
completeness is separate from green results. No skips, TODOs or exit masking are used.

Public errors are copied immediately after validation, including own-property presence and an
explicit undefined state. No params, messages or additionalProperty fields are synthesized.
Authored offending-key/object-pointer metadata is separate from engine output. Missing public
information remains visible and is not a compatibility assertion. The snapshot bound is 16KiB
and the receipt bound is 512KiB. Exceeding either fails loudly without truncation. These are
output bounds for finite fixtures, not universal engine allocation or runtime limits.

The unit job runs this in a separate `!cancelled()` step after the unchanged 197- and 50-callback
diagnostics. It does not test branded compileContract, Cotal consumer error behavior, browser CSP,
full dialect conformance or engine adoption. Hosted checkout, released SRI and the full loaded
closure remain independent provenance gates. Source-only authoring did not run the diagnostic.
