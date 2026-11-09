import assert from 'node:assert/strict';
import { publish } from './rigel-release-publish.mjs';

const sha = 'a'.repeat(40);
const tag = 'rigel-v1.0.0-aaaaaaaaaa';
const assets = ['cotal-runtime-linux-x64.tar.gz', 'cotal-runtime-darwin-arm64.tar.gz', 'SHA256SUMS'];
const ok = (data) => ({ status: 0, stdout: data, stderr: '' });
const ref = (object) => ok(`HTTP/2 200 OK\r\n\r\n${JSON.stringify({ object })}`);
function scenario(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    assert.ok(responses.length, `Unexpected command: ${args.join(' ')}`);
    return responses.shift();
  };
  return { calls, execute: () => publish({ repository: 'example/cotal', tag, sha, run }) };
}

let s = scenario([{ status: 1, stdout: 'HTTP/2 404 Not Found\r\n\r\n{}', stderr: '' }, ok('')]);
s.execute();
assert.equal(s.calls[1][1], 'create');
assert.deepEqual(s.calls[1].slice(-3), assets.map((name) => `dist/${name}`));
s = scenario([ref({ type: 'commit', sha: 'b'.repeat(40) })]);
assert.throws(s.execute, /not a{40}/);
s = scenario([ref({ type: 'tag', sha: 'tag-sha' }), ok(JSON.stringify({ object: { type: 'commit', sha } })), ok(JSON.stringify({ isDraft: false, assets: assets.map((name) => ({ name })) }))]);
s.execute();
assert.equal(s.calls.length, 3);
s = scenario([ref({ type: 'commit', sha }), ok(JSON.stringify({ isDraft: true, assets: [{ name: assets[0] }] })), ok(''), ok('')]);
s.execute();
assert.deepEqual(s.calls[2], ['release', 'upload', tag, `dist/${assets[1]}`, `dist/${assets[2]}`, '--clobber']);
assert.deepEqual(s.calls[3], ['release', 'edit', tag, '--draft=false']);
s = scenario([ref({ type: 'commit', sha }), { status: 1, stdout: '', stderr: 'not found' }]);
assert.throws(s.execute, /Restore the Release or remove the tag/);
s = scenario([{ status: 1, stdout: 'HTTP/2 403 Forbidden\r\n\r\n{}', stderr: 'forbidden' }]);
assert.throws(s.execute, /Could not look up/);
console.log('RIGEL RELEASE PUBLISH SMOKE OK');
