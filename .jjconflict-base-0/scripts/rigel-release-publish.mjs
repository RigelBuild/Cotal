import { spawnSync } from 'node:child_process';
import { isMainEntry } from './main-entry.mjs';

const assets = ['cotal-runtime-linux-x64.tar.gz', 'cotal-runtime-linux-arm64.tar.gz', 'cotal-runtime-darwin-arm64.tar.gz', 'SHA256SUMS'];

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

export function publish({ repository, tag, sha, run = runGh }) {
  const invoke = (args) => {
    const result = run(args);
    if (result.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };
  const refPath = `repos/${repository}/git/ref/tags/${tag}`;
  const refResult = run(['api', '-i', refPath]);
  if (refResult.status !== 0) {
    if (!/^HTTP\/[^\s]+ 404\b/m.test(refResult.stdout ?? '')) {
      throw new Error(`Could not look up ${tag}: ${refResult.stderr}`);
    }
    invoke(['release', 'create', tag, '--target', sha, '--title', tag, '--notes', `Prebuilt Cotal runtime for ${sha}.`, ...assets.map((name) => `dist/${name}`)]);
    return;
  }
  const body = refResult.stdout.split(/\r?\n\r?\n/, 2)[1];
  let object = JSON.parse(body).object;
  while (object.type === 'tag') {
    object = JSON.parse(invoke(['api', `repos/${repository}/git/tags/${object.sha}`])).object;
  }
  if (object.type !== 'commit' || object.sha !== sha) {
    throw new Error(`Release tag ${tag} points to ${object.sha} (${object.type}), not ${sha}.`);
  }
  const view = run(['release', 'view', tag, '--json', 'isDraft,assets']);
  if (view.status !== 0) {
    if (/release not found/i.test(view.stderr)) {
      throw new Error(`Tag ${tag} exists but its Release cannot be read. Restore the Release or remove the tag before retrying.`);
    }
    throw new Error(`gh release view ${tag} failed: ${view.stderr}`);
  }
  const release = JSON.parse(view.stdout);
  const present = new Set(release.assets.map((asset) => asset.name));
  const missing = assets.some((name) => !present.has(name));
  if (missing || release.isDraft) {
    invoke(['release', 'upload', tag, ...assets.map((name) => `dist/${name}`), '--clobber']);
  }
  if (release.isDraft) invoke(['release', 'edit', tag, '--draft=false']);
  if (!missing && !release.isDraft) console.log(`Release ${tag} already has all assets.`);
}

if (isMainEntry(import.meta.url)) {
  try {
    if (!process.env.GITHUB_REPOSITORY || !process.env.TAG || !process.env.SHA) {
      throw new Error('GITHUB_REPOSITORY, TAG and SHA are required');
    }
    publish({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.TAG, sha: process.env.SHA });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
