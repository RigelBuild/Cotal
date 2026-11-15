// Direct released public-error observations. No Cotal compiler or error adapter.
import { describe, it, after } from 'node:test';
import * as nativeAssert from 'node:assert';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packagePath = realpathSync(require.resolve('@exodus/schemasafe/package.json'));
const packageBytes = readFileSync(packagePath);
const metadata = JSON.parse(packageBytes);
if (metadata.name !== '@exodus/schemasafe' || metadata.version !== '1.3.0' ||
    Object.keys(metadata.dependencies ?? {}).length !== 0)
  throw new Error('Public-error diagnostic requires released schemasafe 1.3.0');
const entryPath = realpathSync(require.resolve('@exodus/schemasafe'));
const entryBytes = readFileSync(entryPath);
const { validator } = require('@exodus/schemasafe');
if (typeof validator !== 'function') throw new Error('Missing public validator');
const inputBytes = readFileSync(new URL('./schema-schemasafe-public-errors.cells.json', import.meta.url));
const inputSha256 = hash(inputBytes);
if (inputSha256 !== '4d5fc76f387b7b36076d2082105231d37e5135b4f328554067951ec9b8616cc0') throw new Error('Public-error fixture bytes changed');
const corpus = JSON.parse(inputBytes);
const caseIds = ['root-additional', 'nested-additional', 'referenced-additional', 'escaped-key',
  'multiple-extra', 'pattern-properties', 'unevaluated-branch', 'ordinary-type'];
if (corpus.cases.length !== 8 || corpus.cases.some((row, index) => row.id !== caseIds[index]))
  throw new Error('Expected the eight selected public-error cases');
const options = Object.freeze({
  mode: 'spec', includeErrors: true, allErrors: true, formatAssertion: false,
  useDefaults: false, removeAdditional: false, isJSON: false, unmodifiedPrototypes: false,
  $schemaDefault: 'https://json-schema.org/draft/2020-12/schema',
});
const sourceHead = process.env.GITHUB_SHA;
if (typeof sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(sourceHead))
  throw new Error('Public-error diagnostic requires hosted source-head provenance');
const provenance = {
  sourceHead, sourceHeadSource: 'GITHUB_SHA, join independently to hosted checkout',
  testSha256: hash(readFileSync(new URL(import.meta.url))), inputSha256,
  package: { name: metadata.name, version: metadata.version, path: packagePath,
    bytes: packageBytes.length, sha256: hash(packageBytes) },
  entry: { path: entryPath, bytes: entryBytes.length, sha256: hash(entryBytes) },
  runtime: { node: process.versions.node, v8: process.versions.v8,
    platform: process.platform, arch: process.arch },
  archiveIntegrityAndFullLoadedClosureVerifiedHere: false,
};
const limits = Object.freeze({ errorSnapshotBytes: 16384, receiptBytes: 524288 });
const clone = value => JSON.parse(JSON.stringify(value));
const expectedIds = caseIds.flatMap(id => [`${id}/valid`, `${id}/invalid`]);
const observed = { testsStarted: 0, testsEnded: 0, testsPassed: 0, testsFailed: 0,
  assertionAttempts: 0, assertionsPassed: 0, assertionsFailed: 0, rows: [] };
let current;
function check(method, actual, expected) {
  if (!current) throw new Error('Assertion outside a public-error callback');
  observed.assertionAttempts++; current.assertionAttempts++;
  try {
    nativeAssert[method](actual, expected);
    observed.assertionsPassed++; current.assertionsPassed++;
  } catch (error) {
    observed.assertionsFailed++; current.assertionsFailed++;
    throw error;
  }
}
after(() => {
  const complete = !current && observed.rows.length === 16 &&
    new Set(observed.rows.map(row => row.id)).size === 16 &&
    observed.rows.every((row, index) => row.id === expectedIds[index]) &&
    observed.testsStarted === 16 && observed.testsEnded === 16 &&
    observed.testsPassed + observed.testsFailed === 16 && observed.assertionAttempts <= 112 &&
    observed.assertionsPassed + observed.assertionsFailed === observed.assertionAttempts &&
    ['assertionAttempts', 'assertionsPassed', 'assertionsFailed'].every(field =>
      observed.rows.reduce((sum, row) => sum + row[field], 0) === observed[field]);
  const receipt = JSON.stringify({ kind: 'direct-schemasafe16-public-error-diagnostic',
    executionLevel: 'DIRECT_PUBLIC_ENGINE_NOT_COTAL_ERROR_ADAPTER_OR_BROWSER',
    runner: 'stock node:test', expectedTests: 16, maximumPlannedAssertions: 112,
    complete, options, limits, provenance, ...observed });
  if (Buffer.byteLength(receipt, 'utf8') > limits.receiptBytes)
    throw new Error('Public-error receipt exceeds explicit bound; nothing was truncated');
  console.log(receipt);
  if (!complete) throw new Error('Incomplete public-error callback accounting');
});
describe('Released schemasafe public errors', { concurrency: false }, () => {
  for (const fixture of corpus.cases) {
    for (const control of ['valid', 'invalid']) {
      it(`${fixture.id}/${control}`, () => {
        if (current) throw new Error('Overlapping public-error callbacks');
        current = { id: `${fixture.id}/${control}`, phase: 'setup', actual: null,
          expected: control === 'valid', fixtureOffendingKeys: control === 'invalid' ? clone(fixture.offendingKeys) : [],
          fixtureInvalidValuePointer: control === 'invalid' ? fixture.invalidValuePointer ?? null : null,
          assertionAttempts: 0, assertionsPassed: 0, assertionsFailed: 0, failure: null };
        observed.testsStarted++;
        try {
          const schema = clone(fixture.schema), value = clone(fixture[control]);
          const schemaBefore = JSON.stringify(schema), valueBefore = JSON.stringify(value);
          current.phase = 'compile';
          const validate = validator(schema, options);
          check('strictEqual', typeof validate, 'function');
          current.phase = 'validate-and-capture';
          const actual = validate(value);
          current.actual = actual;
          // Capture immediately, before any subsequent call can replace validate.errors.
          const rawErrors = validate.errors;
          const own = Object.hasOwn(validate, 'errors');
          if (rawErrors === undefined) {
            current.publicErrors = { own, valueState: 'undefined' };
            check('strictEqual', rawErrors, undefined);
          } else {
            const bytes = JSON.stringify(rawErrors);
            if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > limits.errorSnapshotBytes)
              throw new Error('Public errors exceed capture bound or are not JSON; nothing was truncated');
            const snapshot = JSON.parse(bytes);
            current.publicErrors = { own, valueState: 'json', value: snapshot };
            check('deepStrictEqual', snapshot, rawErrors);
          }
          check('strictEqual', Buffer.byteLength(JSON.stringify(current.publicErrors), 'utf8') <= limits.errorSnapshotBytes, true);
          check('strictEqual', typeof actual, 'boolean');
          check('strictEqual', JSON.stringify(schema), schemaBefore);
          check('strictEqual', JSON.stringify(value), valueBefore);
          current.phase = 'expected-verdict';
          check('strictEqual', actual, current.expected);
        } catch (error) {
          current.failure = { name: error?.name ?? typeof error, code: error?.code ?? null,
            message: String(error?.message ?? error) };
          throw error;
        } finally {
          observed.testsEnded++;
          if (current.failure) observed.testsFailed++; else observed.testsPassed++;
          observed.rows.push(current); current = undefined;
        }
      });
    }
  }
});
