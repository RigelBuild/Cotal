// Direct released-engine diagnostic only. No compileContract or browser acceptance.
import { describe, it, after } from 'node:test';
import * as nativeAssert from 'node:assert';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packagePath = realpathSync(require.resolve('@exodus/schemasafe/package.json'));
const packageBytes = readFileSync(packagePath);
const packageMetadata = JSON.parse(packageBytes);
if (packageMetadata.name !== '@exodus/schemasafe' || packageMetadata.version !== '1.3.0' ||
    Object.keys(packageMetadata.dependencies ?? {}).length !== 0)
  throw new Error('Comparison requires released zero-dependency @exodus/schemasafe 1.3.0');
const entryPath = realpathSync(require.resolve('@exodus/schemasafe'));
const entryBytes = readFileSync(entryPath);
const { validator } = require('@exodus/schemasafe');
if (typeof validator !== 'function') throw new Error('Public validator entry is not a function');
const inputBytes = readFileSync(new URL('./schema-remaining15-diagnostic.cells.json', import.meta.url));
const inputSha256 = hash(inputBytes);
if (inputSha256 !== '7efb4a8e104605c94aac8d93823124d216f0065172cb2a5b192503190da690d7')
  throw new Error('Exact retained diagnostic corpus bytes changed');
const corpus = JSON.parse(inputBytes);
const configuration = 'schemasafe130-spec-all-errors';
const options = Object.freeze({
  mode: 'spec', includeErrors: true, allErrors: true, formatAssertion: false,
  useDefaults: false, removeAdditional: false, isJSON: false, unmodifiedPrototypes: false,
  $schemaDefault: 'https://json-schema.org/draft/2020-12/schema',
});
const sourceHead = process.env.GITHUB_SHA;
if (typeof sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(sourceHead))
  throw new Error('Comparison requires hosted CI source-head provenance');
const provenance = {
  sourceHead, sourceHeadSource: 'GITHUB_SHA, independently join to hosted checkout',
  testSha256: hash(readFileSync(new URL(import.meta.url))), inputSha256,
  package: { name: packageMetadata.name, version: packageMetadata.version,
    path: packagePath, bytes: packageBytes.length, sha256: hash(packageBytes) },
  entry: { path: entryPath, bytes: entryBytes.length, sha256: hash(entryBytes) },
  runtime: { node: process.versions.node, v8: process.versions.v8,
    platform: process.platform, arch: process.arch },
  packageManager: 'pnpm@11.28.2 declared by repository; verify actual CI tool separately',
  publishedArchiveIntegrityVerifiedHere: false,
};
const clone = value => JSON.parse(JSON.stringify(value));
const expectedIds = ['census', ...corpus.official15.map(row => row.id),
  ...corpus.independent33.map(row => row.id), 'closed-pointer'];
const observed = { testsStarted: 0, testsEnded: 0, testsPassed: 0, testsFailed: 0,
  assertionAttempts: 0, assertionsPassed: 0, assertionsFailed: 0, rows: [] };
let current;
function start(id, group) {
  if (current) throw new Error('Overlapping comparison callbacks');
  current = { configuration, id, group, phase: 'setup', actual: null,
    assertionAttempts: 0, assertionsPassed: 0, assertionsFailed: 0, error: null };
  observed.testsStarted++;
}
const assert = {
  strictEqual(actual, expected) {
    if (!current) throw new Error('Assertion outside comparison callback');
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
  const actualIds = observed.rows.map(row => row.id);
  const complete = !current && expectedIds.length === 50 && new Set(expectedIds).size === 50 &&
    actualIds.length === 50 && actualIds.every((id, index) => id === expectedIds[index]) &&
    observed.testsStarted === 50 && observed.testsEnded === 50 &&
    observed.testsPassed + observed.testsFailed === 50 &&
    observed.assertionAttempts <= 246 &&
    observed.assertionsPassed + observed.assertionsFailed === observed.assertionAttempts &&
    observed.rows.reduce((sum, row) => sum + row.assertionAttempts, 0) === observed.assertionAttempts;
  console.log(JSON.stringify({ kind: 'direct-schemasafe50-node-test-comparison', runner: 'stock node:test',
    executionLevel: 'DIRECT_ENGINE_NOT_compileContract_OR_BROWSER_ACCEPTANCE',
    expectedTests: 50, maximumPlannedAssertions: 246, candidateConfigurations: 1, complete,
    options, provenance, ...observed }));
  if (!complete) throw new Error('Incomplete comparison census, not a measured 50-test result');
});
describe('Released schemasafe comparison of retained PR3780 inputs', { concurrency: false }, () => {
  it('retains fifteen official witnesses and thirty-three paired controls', () => {
    start('census', 'census');
    try {
      current.phase = 'census';
      assert.strictEqual(corpus.official15.length, 15);
      assert.strictEqual(corpus.independent33.length, 33);
      assert.strictEqual(corpus.configurationGrid.length, 4); // Retained Ajv grid, not candidate configurations.
    } catch (error) { recordFailure(error); throw error; }
    finally { finish(); }
  });
  for (const [group, rows] of [['official15', corpus.official15], ['independent33', corpus.independent33]]) {
    for (const row of rows) {
      it(`${row.id} expected ${row.expected}: ${row.case ?? row.basis}`, () => {
        start(row.id, group);
        try {
          const schema = clone(row.schema);
          const instance = clone(row.value);
          const schemaBytes = JSON.stringify(schema);
          const instanceBytes = JSON.stringify(instance);
          current.phase = 'compile';
          const validate = validator(schema, options);
          assert.strictEqual(typeof validate, 'function');
          current.phase = 'validate';
          const actual = validate(instance);
          current.actual = actual;
          assert.strictEqual(typeof actual, 'boolean');
          assert.strictEqual(JSON.stringify(schema), schemaBytes);
          assert.strictEqual(JSON.stringify(instance), instanceBytes);
          current.phase = 'expected-verdict';
          assert.strictEqual(actual, row.expected);
        } catch (error) { recordFailure(error); throw error; }
        finally { finish(); }
      });
    }
  }
  it('preserves authored ID and separate retrieval-alias JSON pointer', () => {
    start('closed-pointer', 'closedPointer');
    try {
      const witness = clone(corpus.closedPointer);
      const digest = Object.keys(witness.bundle.members)[0];
      const member = witness.bundle.members[digest];
      const sourceBytes = JSON.stringify(witness.bundle);
      current.phase = 'compile';
      const validate = validator(witness.bundle.root, {
        ...options, schemas: new Map([[`cotal:${digest}`, member], [member.$id, member]]),
      });
      current.phase = 'validate-pointer';
      current.actual = [];
      const first = validate(witness.values[0]);
      current.actual.push(first);
      assert.strictEqual(first, witness.expected[0]);
      const second = validate(witness.values[1]);
      current.actual.push(second);
      assert.strictEqual(second, witness.expected[1]);
      assert.strictEqual(JSON.stringify(witness.bundle), sourceBytes);
    } catch (error) { recordFailure(error); throw error; }
    finally { finish(); }
  });
});
