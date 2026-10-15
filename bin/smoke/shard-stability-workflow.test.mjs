// Exercise the shipped detector CLI and its committed-input reads, not a copy of its parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const detector = fileURLToPath(new URL('./shard-stability.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const verifier = readFileSync(new URL('./verify-shard-inputs.sh', import.meta.url), 'utf8');
const exclusion = "    if: ${{ github.event_name != 'workflow_dispatch' }}";
const header = `  smoke:\n${exclusion}\n`;
assert.equal(workflow.split(header).length, 2, 'Regression requires the actual unique smoke job');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key.startsWith('COTAL_')) delete env[key];
for (const key of ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS']) delete env[key];
const registry = Array.from({ length: 24 }, (_, i) => `smoke:topology-${i}`).join('\n') + '\n';
const withCondition = condition => workflow.replace(header,
  `  smoke:\n${condition === null ? '' : `    if: ${condition}\n`}`);
const run = (baseWorkflow, headWorkflow, headRegistry = registry) => {
  const root = mkdtempSync(join(tmpdir(), 'shard-workflow-regression-'));
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, value) => writeFileSync(join(root, path), value);
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'bin/smoke/ci-suites.d'), { recursive: true });
    write('.github/workflows/ci.yml', baseWorkflow);
    write('bin/smoke/verify-shard-inputs.sh', verifier);
    write('bin/smoke/ci-suites.txt', registry);
    write('bin/smoke/ci-suite-costs.json', '{"count":4,"suites":{}}\n');
    git('init', '-q');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Topology control',
      '-c', 'user.email=topology-control@example.invalid', 'commit', '-qm', 'test: base topology');
    const base = git('rev-parse', 'HEAD');
    write('.github/workflows/ci.yml', headWorkflow);
    write('bin/smoke/ci-suites.txt', headRegistry);
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Topology control',
      '-c', 'user.email=topology-control@example.invalid', 'commit', '--allow-empty', '-qm', 'test: head topology');
    const head = git('rev-parse', 'HEAD');
    const result = spawnSync(process.execPath, ['--import', tsx, detector, base, head],
      { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.error, undefined, 'The actual detector must return, not time out');
    assert.equal(result.signal, null);
    const output = result.stdout + result.stderr;
    assert.match(output, /shard-stability.check v1 starting/);
    const tokens = [...output.matchAll(/^shard-stability: ([A-Z]+)=([0-9])$/gm)];
    assert.equal(tokens.length, 1, 'Exactly one detector verdict, not a launch-only result');
    assert.equal(Number(tokens[0][2]), result.status, 'Verdict and actual exit agree');
    return { status: result.status, token: tokens[0][1], output };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const expect = (result, status, token) => {
  assert.equal(result.status, status, result.output);
  assert.equal(result.token, token, result.output);
};
test('the shipped detector accepts only the fixed manual exclusion on an unchanged ordinary topology', () => {
  expect(run(withCondition(null), workflow), 0, 'STABLE');
  expect(run(workflow, workflow), 0, 'STABLE');
  expect(run(withCondition(null), withCondition(null)), 0, 'STABLE');
});
test('the shipped detector still detects a real index move with the manual exclusion', () => {
  const names = registry.trim().split('\n');
  const changed = [names[1], names[0], ...names.slice(2)].join('\n') + '\n';
  const result = run(workflow, workflow, changed);
  expect(result, 1, 'RESHARD');
  assert.match(result.output, /frozen legacy suites CHANGING INDEX: 2 of 24 examined/);
});
test('the shipped detector refuses unsupported smoke job conditions instead of inventing topology', () => {
  for (const condition of ['${{ false }}', '${{ true }}',
    "${{ github.event_name == 'pull_request' }}",
    "${{ github.event_name != 'workflow_dispatch' || true }}", 'always()']) {
    expect(run(workflow, withCondition(condition)), 2, 'ABORT');
  }
});
test('the shipped detector refuses duplicate and quoted job conditions', () => {
  expect(run(workflow, workflow.replace(header, `${header}${exclusion}\n`)), 2, 'ABORT');
  expect(run(workflow, workflow.replace(header, `  smoke:\n    "if": \${{ github.event_name != 'workflow_dispatch' }}\n`)), 2, 'ABORT');
});
test('the shipped detector retains fail-closed matrix and shard-step checks', () => {
  expect(run(workflow, workflow.replace('        shard: [0, 1, 2, 3]', '        shard: [0, 1, 2, 2]')), 2, 'ABORT');
  const step = '      - name: Protocol & security smoke tests (shard ${{ matrix.shard }}/4)';
  assert.equal(workflow.split(step).length, 2);
  expect(run(workflow, workflow.replace(step, `${step}\n        if: \${{ false }}`)), 2, 'ABORT');
});
