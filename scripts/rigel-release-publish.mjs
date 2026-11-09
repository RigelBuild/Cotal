import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = ['cotal-runtime-linux-x64.tar.gz', 'cotal-runtime-darwin-arm64.tar.gz', 'SHA256SUMS'];

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
  let release;
  try {
    release = JSON.parse(invoke(['release', 'view', tag, '--json', 'isDraft,assets']));
  } catch (error) {
    throw new Error(`Tag ${tag} exists but its Release cannot be read. Restore the Release or remove the tag before retrying.`, { cause: error });
  }
  const present = new Set(release.assets.map((asset) => asset.name));
  const missing = assets.filter((name) => !present.has(name));
  if (missing.length) invoke(['release', 'upload', tag, ...missing.map((name) => `dist/${name}`), '--clobber']);
  if (release.isDraft) invoke(['release', 'edit', tag, '--draft=false']);
  if (!missing.length && !release.isDraft) console.log(`Release ${tag} already has all assets.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publish({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.TAG, sha: process.env.SHA });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
