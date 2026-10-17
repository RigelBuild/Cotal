// Direct Ajv diagnostic only. Stock node:test, not the maintained upstream Mocha runner.
// No compileContract conformance, repaired verdict or browser acceptance is claimed.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, it, after } from 'node:test';
import * as nativeAssert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const engineVersion = JSON.parse(readFileSync(require.resolve('ajv/package.json'), 'utf8')).version;
if (engineVersion !== '8.20.0') throw new Error('Diagnostic requires frozen Ajv 8.20.0');
const inputBytes = readFileSync(new URL('./schema-remaining15-diagnostic.cells.json', import.meta.url));
const inputSha256 = createHash('sha256').update(inputBytes).digest('hex');
if (inputSha256 !== '7efb4a8e104605c94aac8d93823124d216f0065172cb2a5b192503190da690d7')
  throw new Error('Exact diagnostic corpus bytes changed');
const corpus = JSON.parse(inputBytes);
const clone = value => JSON.parse(JSON.stringify(value));
const observed = { testsStarted: 0, testsEnded: 0, testsPassed: 0, testsFailed: 0,
  assertionAttempts: 0, assertionsPassed: 0, assertionsFailed: 0, rows: [] };
const captureIds = new Set(['M09', 'M10', 'M09-C2', 'M09-C3', 'M10-C1', 'M19', 'M20', 'M19-C2']);
const nativeCaptures = [];
let captureBytes = 0;
function boundedBytes(text, limit, label) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limit) throw new Error(`Native diagnostic capture refused: ${label} exceeds ${limit} bytes`);
  return bytes;
}
function detachedValue(value, label) {
  // Encode undefined explicitly so JSON output retains native metadata fields.
  const text = JSON.stringify(value, (_key, item) =>
    item === undefined ? { diagnosticValue: 'undefined' } : item);
  boundedBytes(text, 16 * 1024, label);
  return JSON.parse(text);
}
function nativeSnapshot(validate, key) {
  const value = validate[key];
  return { present: key in validate, own: Object.hasOwn(validate, key),
    type: typeof value, value: detachedValue(value, key) };
}
function captureNative(configuration, id, actual, validate, ajv) {
  if (configuration !== 'shipped-pin' || !captureIds.has(id)) return;
  const errors = nativeSnapshot(validate, 'errors');
  const evaluated = nativeSnapshot(validate, 'evaluated');
  const body = validate.toString();
  const bodyBytes = boundedBytes(body, 64 * 1024, 'validator body');
  const capture = { configuration, id, actual, errors, evaluated,
    effectiveOptions: detachedValue({ strict: ajv.opts.strict, allErrors: ajv.opts.allErrors,
      inlineRefs: ajv.opts.inlineRefs, ownProperties: ajv.opts.ownProperties,
      validateFormats: ajv.opts.validateFormats, unicodeRegExp: ajv.opts.unicodeRegExp,
      loadSchema: ajv.opts.loadSchema, unevaluated: ajv.opts.unevaluated,
      dynamicRef: ajv.opts.dynamicRef, next: ajv.opts.next }, 'effective options'),
    validator: { body, bytes: bodyBytes,
      sha256: createHash('sha256').update(body, 'utf8').digest('hex') } };
  const bytes = boundedBytes(JSON.stringify(capture), 128 * 1024, 'row');
  if (captureBytes + bytes > 512 * 1024)
    throw new Error('Native diagnostic capture refused: aggregate exceeds 524288 bytes');
  nativeCaptures.push(capture);
  captureBytes += bytes;
}
let current;
function start(configuration, id) {
  if (current) throw new Error('Overlapping diagnostic test callbacks');
  current = { configuration, id, assertionAttempts: 0, assertionsPassed: 0,
    assertionsFailed: 0, error: null };
  observed.testsStarted++;
}
const assert = {
  strictEqual(actual, expected) {
    if (!current) throw new Error('Assertion outside diagnostic test callback');
    observed.assertionAttempts++;
    current.assertionAttempts++;
    try {
      nativeAssert.strictEqual(actual, expected);
      observed.assertionsPassed++;
      current.assertionsPassed++;
    } catch (error) {
      observed.assertionsFailed++;
      current.assertionsFailed++;
      throw error;
    }
  },
};
function recordFailure(error) {
  current.error = { name: error?.name ?? typeof error, code: error?.code ?? null,
    message: String(error?.message ?? error) };
}
function finish() {
  observed.testsEnded++;
  if (current.error) observed.testsFailed++;
  else observed.testsPassed++;
  observed.rows.push(current);
  current = undefined;
}
after(() => {
  const complete = !current && observed.testsStarted === 197 && observed.testsEnded === 197 &&
    observed.testsPassed + observed.testsFailed === 197 && observed.rows.length === 197 &&
    observed.assertionsPassed + observed.assertionsFailed === observed.assertionAttempts &&
    observed.rows.reduce((sum, row) => sum + row.assertionAttempts, 0) === observed.assertionAttempts;
  console.log(JSON.stringify({ kind: 'direct-ajv197-node-test-diagnostic', runner: 'stock node:test',
    executionLevel: 'DIRECT_ENGINE_NOT_SHIPPED_compileContract', expectedTests: 197, complete,
    ...observed, nativeCaptures, captureBytes, engineVersion, inputSha256,
    entry: import.meta.resolve('ajv/dist/2020.js') }));
  if (!complete) throw new Error('Incomplete diagnostic census, not a measured 197-test result');
});
describe("2020-12 dynamic targets and evaluated annotation regressions", { concurrency: false }, () => {
  it("retains fifteen official witnesses and thirty-three independent controls", () => {
    start("census", "census")
    try {
    assert.strictEqual(corpus.official15.length, 15)
    assert.strictEqual(corpus.independent33.length, 33)
    assert.strictEqual(corpus.configurationGrid.length, 4)
    } catch (error) { recordFailure(error); throw error }
    finally { finish() }
  })
  for (const config of corpus.configurationGrid) {
    describe(config.name, { concurrency: false }, () => {
      for (const row of [...corpus.official15, ...corpus.independent33]) {
        it(`${row.id} expected ${row.expected}: ${row.case ?? row.basis}`, () => {
          start(config.name, row.id)
          try {
          const schema = clone(row.schema)
          const instance = clone(row.value)
          const schemaBytes = JSON.stringify(schema)
          const instanceBytes = JSON.stringify(instance)
          const ajv = new Ajv2020({
            strict: false,
            allErrors: config.allErrors,
            inlineRefs: config.inlineRefs,
            ownProperties: true,
            validateFormats: false,
            unicodeRegExp: true,
            loadSchema: undefined,
          })
          const validate = ajv.compile(schema)
          assert.strictEqual(typeof validate, "function")
          const actual = validate(instance)
          captureNative(config.name, row.id, actual, validate, ajv)
          assert.strictEqual(typeof actual, "boolean")
          assert.strictEqual(JSON.stringify(schema), schemaBytes)
          assert.strictEqual(JSON.stringify(instance), instanceBytes)
          // Final assertion is the normative verdict, not a generated-code heuristic.
          assert.strictEqual(actual, row.expected)
          } catch (error) { recordFailure(error); throw error }
          finally { finish() }
        })
      }
      it("preserves authored ID and separate retrieval-alias JSON pointer", () => {
        start(config.name, "closed-pointer")
        try {
        const witness = clone(corpus.closedPointer)
        const root = witness.bundle.root
        const digest = Object.keys(witness.bundle.members)[0]
        const member = witness.bundle.members[digest]
        const sourceBytes = JSON.stringify(witness.bundle)
        const ajv = new Ajv2020({
          strict: false, allErrors: config.allErrors, inlineRefs: config.inlineRefs,
          ownProperties: true, validateFormats: false, unicodeRegExp: true,
          loadSchema: undefined,
        })
        ajv.addSchema(member, `cotal:${digest}`)
        const validate = ajv.compile(root)
        assert.strictEqual(validate(witness.values[0]), witness.expected[0])
        assert.strictEqual(validate(witness.values[1]), witness.expected[1])
        assert.strictEqual(JSON.stringify(witness.bundle), sourceBytes)
        } catch (error) { recordFailure(error); throw error }
        finally { finish() }
      })
    })
  }
})
