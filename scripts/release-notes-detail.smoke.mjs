import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { firstSentence } from './release-notes-detail.mjs';
import { createSuite } from '../bin/smoke/sentinel.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/release-notes-detail.mjs');
const suite = createSuite();
const dirs = [];
const version = '9.8.7';
function fixture(changelog) {
  const dir = mkdtempSync(join(tmpdir(), 'cotal-release-notes-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/package.json'), JSON.stringify({ version }));
  if (changelog !== undefined) writeFileSync(join(dir, 'bin/CHANGELOG.md'), changelog);
  return dir;
}
function detail(dir, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  return result;
}

// This fork does not publish to npm or announce on Discord; it releases through rigel-release.yml,
// so only the release-notes helper itself is tested here.

try {
  const valid = fixture(`# Changelog\n\n## ${version}\n\n- abcdef1: A real summary\n\n  A second paragraph.\n\n- Updated dependencies\n\n## 9.8.6\n\n- An older change\n`);
  mkdirSync(join(valid, 'packages', 'copy'), { recursive: true });
  copyFileSync(join(valid, 'bin/CHANGELOG.md'), join(valid, 'packages/copy/CHANGELOG.md'));
  const good = detail(valid, version);
  suite.check('valid release succeeds', good.status === 0, good.stderr);
  const layers = good.stdout.split('<details>');
  suite.check('summary appears once in each layer across packages', layers.length === 2 && layers.every(layer => layer.split('- A real summary').length - 1 === 1));
  suite.check('a heading retains its first line rather than later prose', firstSentence('# A headline.\n\nSupporting detail.') === '# A headline.');
  suite.check('a list retains its first line rather than later prose', firstSentence('- A headline.\n\nSupporting detail.') === '- A headline.');
  suite.check('multi-paragraph summary is preserved', good.stdout.includes('  A second paragraph.'));
  suite.check('dependency bookkeeping and older versions stay out', !/Updated dependencies|An older change/.test(good.stdout));

  const missing = detail(valid, '99.99.99');
  suite.check('missing version fails', missing.status !== 0);
  suite.check('missing version reports its diagnostic on stderr', /no changelog section/.test(missing.stderr) && missing.stderr.includes('99.99.99'));
  suite.check('missing version emits no partial notes', missing.stdout === '');

  const empty = fixture(`## ${version}\n\n- Updated dependencies\n- @scope/dependency@1.2.3\n`);
  const noSummaries = detail(empty, version);
  suite.check('dependency-only section fails', noSummaries.status !== 0);
  suite.check('empty parse reports missing summaries', /no release summaries/.test(noSummaries.stderr));
  suite.check('empty parse emits no partial notes', noSummaries.stdout === '');

  const noArgs = detail(valid);
  suite.check('missing argument retains usage refusal', noArgs.status !== 0 && noArgs.stderr.includes('usage:'));
  const badBudget = detail(valid, version, '--max-bytes=0');
  suite.check('invalid budget remains an explicit failure', badBudget.status !== 0 && badBudget.stderr.includes('positive number'));
  const large = fixture(`## ${version}\n\n` + Array.from({ length: 20 }, (_, i) => `- Change ${i}: ${'x'.repeat(100)}\n`).join(''));
  const bounded = detail(large, version, '--max-bytes=512');
  suite.check('valid summaries still respect the byte budget', bounded.status === 0 && Buffer.byteLength(bounded.stdout) <= 512);
  suite.check('truncation remains explicit', bounded.stdout.includes('more changes did not fit'));
  const tiny = detail(valid, version, '--max-bytes=1');
  suite.check('an impossible budget refuses without partial output', tiny.status !== 0 && tiny.stdout === '');
  const unicode = fixture(`## ${version}\n\n` + Array.from({ length: 20 }, (_, i) => `- Change ${i}: ${'é'.repeat(70)}\n`).join(''));
  const byteBounded = detail(unicode, version, '--max-bytes=600');
  suite.check('the budget counts UTF-8 bytes rather than characters', byteBounded.status === 0 && Buffer.byteLength(byteBounded.stdout) <= 600 && byteBounded.stdout.endsWith('</details>\n'));
  suite.check('all 18 behavioral assertions ran', suite.passed() + suite.failed() === 18);
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  suite.finish();
}
