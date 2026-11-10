import assert from 'node:assert/strict';
import { publish } from './rigel-release-publish.mjs';

const sha = 'a'.repeat(40);
const tag = 'rigel-v1.0.0-aaaaaaaaaa';
const assets = ['cotal-runtime-linux-x64.tar.gz', 'cotal-runtime-darwin-arm64.tar.gz', 'SHA256SUMS'];
const paths = assets.map((name) => `dist/${name}`);
const ok = (data = '') => ({ status: 0, stdout: data, stderr: '' });
const ref = (object) => ok(`HTTP/2 200 OK\r\n\r\n${JSON.stringify({ object })}`);
const lookup = ['api', '-i', `repos/example/cotal/git/ref/tags/${tag}`];
const view = ['release', 'view', tag, '--json', 'isDraft,assets'];
const upload = ['release', 'upload', tag, ...paths, '--clobber'];
const edit = ['release', 'edit', tag, '--draft=false'];
const release = (isDraft, names) => ok(JSON.stringify({ isDraft, assets: names.map((name) => ({ name })) }));
function scenario(steps, expectedError) {
  const remaining = [...steps];
  const run = (args) => {
    assert.ok(remaining.length, `Unexpected command: ${args.join(' ')}`);
    const [expected, response] = remaining.shift();
    assert.deepEqual(args, expected);
    return response;
  };
  const execute = () => publish({ repository: 'example/cotal', tag, sha, run });
  if (expectedError) assert.throws(execute, (error) => error.message === expectedError.message);
  else execute();
  assert.equal(remaining.length, 0, 'Expected commands were not called');
}

scenario([
  [lookup, { status: 1, stdout: 'HTTP/2 404 Not Found\r\n\r\n{}', stderr: '' }],
  [['release', 'create', tag, '--target', sha, '--title', tag, '--notes',
    `Prebuilt Cotal runtime for ${sha}.`, ...paths], ok()],
]);
scenario([[lookup, ref({ type: 'commit', sha: 'b'.repeat(40) })]],
  { message: `Release tag ${tag} points to ${'b'.repeat(40)} (commit), not ${sha}.` });
scenario([
  [lookup, ref({ type: 'tag', sha: 'tag-sha' })],
  [['api', 'repos/example/cotal/git/tags/tag-sha'], ok(JSON.stringify({ object: { type: 'tree', sha: 'c'.repeat(40) } }))],
], { message: `Release tag ${tag} points to ${'c'.repeat(40)} (tree), not ${sha}.` });
const logs = [];
const originalLog = console.log;
try {
  console.log = (line) => logs.push(line);
  scenario([
    [lookup, ref({ type: 'tag', sha: 'tag-sha' })],
    [['api', 'repos/example/cotal/git/tags/tag-sha'], ok(JSON.stringify({ object: { type: 'commit', sha } }))],
    [view, release(false, assets)],
  ]);
} finally { console.log = originalLog; }
assert.deepEqual(logs, [`Release ${tag} already has all assets.`]);
scenario([
  [lookup, ref({ type: 'commit', sha })], [view, release(false, [assets[0]])], [upload, ok()],
]);
scenario([
  [lookup, ref({ type: 'commit', sha })], [view, release(true, assets)], [upload, ok()], [edit, ok()],
]);
scenario([
  [lookup, ref({ type: 'commit', sha })],
  [view, { status: 1, stdout: '', stderr: 'release not found' }],
], { message: `Tag ${tag} exists but its Release cannot be read. Restore the Release or remove the tag before retrying.` });
scenario([
  [lookup, ref({ type: 'commit', sha })],
  [view, { status: 1, stdout: '', stderr: 'HTTP 403 forbidden' }],
], { message: `gh release view ${tag} failed: HTTP 403 forbidden` });
scenario([[lookup, { status: 1, stdout: 'HTTP/2 403 Forbidden\r\n\r\n{}', stderr: 'forbidden' }]], { message: `Could not look up ${tag}: forbidden` });
console.log('RIGEL RELEASE PUBLISH SMOKE OK');
