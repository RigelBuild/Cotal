// Observations of returned tool text only. Shapes can be forged, not causes or tool provenance.
const scanCharacters = 65_536;
const counterLimit = 1_024;
const count = (text, shape) => Math.min(counterLimit, [...text.matchAll(shape)].length);
const codes = [
  ['PNPM_MISSING_TIME_HEADER', 'ERR_PNPM_MISSING_TIME'],
  ['PNPM_NO_MATURE_VERSION_HEADER', 'ERR_PNPM_NO_MATURE_MATCHING_VERSION'],
  ['PNPM_NO_MATCHING_VERSION_HEADER', 'ERR_PNPM_NO_MATCHING_VERSION'],
  ['PNPM_FETCH_401_HEADER', 'ERR_PNPM_FETCH_401'],
  ['PNPM_FETCH_403_HEADER', 'ERR_PNPM_FETCH_403'],
  ['PNPM_LOCKFILE_CONFLICT_HEADER', 'ERR_PNPM_CONFIG_CONFLICT_LOCKFILE_ONLY_WITH_NO_LOCKFILE'],
];
function streamObservation(value) {
  const state = value === null || value === undefined ? 'ABSENT'
    : typeof value === 'string' ? 'TEXT' : 'UNSUPPORTED';
  const text = state === 'TEXT' ? value.slice(0, scanCharacters).replace(/\x1b\[[0-9;]*m/g, '') : '';
  const codeHeaders = count(text, /^[ \t]*\[ERR_PNPM_[A-Z0-9_]+\][ \t]/gm);
  const genericHeaders = count(text, /^[ \t]*\[ERROR\][ \t]/gm);
  const unknownOptionHeaders = count(text, /^[ \t]*\[ERROR\][ \t]+Unknown options?:[ \t]/gm);
  const categories = [];
  if (codeHeaders) categories.push('PNPM_CODE_HEADER');
  if (genericHeaders) categories.push('PNPM_GENERIC_HEADER');
  if (unknownOptionHeaders) categories.push('PNPM_UNKNOWN_OPTION_HEADER');
  for (const [label, code] of codes)
    if (new RegExp(`^[ \\t]*\\[${code}\\][ \\t]`, 'm').test(text)) categories.push(label);
  return { state, characters: state === 'TEXT' ? Math.min(value.length, scanCharacters) : 0,
    scanComplete: state === 'TEXT' && value.length <= scanCharacters,
    codeHeaders, genericHeaders, unknownOptionHeaders,
    categories: categories.length ? categories : ['UNKNOWN'] };
}
export function acquisitionToolResult(result) {
  if (result.error || result.status !== 0) {
    // Never serialize the error, command, environment, or any captured text or token.
    const observation = { kind: 'validator-acquisition-tool-refusal',
      status: result.status === null ? null : Number.isInteger(result.status) && result.status >= 0 && result.status <= 255
        ? result.status : 'OTHER',
      signal: result.signal === null || result.signal === undefined ? null
        : ['SIGKILL', 'SIGTERM'].includes(result.signal) ? result.signal : 'OTHER',
      errorCode: result.error?.code === null || result.error?.code === undefined ? null
        : ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOBUFS', 'E2BIG'].includes(result.error.code)
          ? result.error.code : 'OTHER',
      stdout: streamObservation(result.stdout), stderr: streamObservation(result.stderr), cause: 'UNKNOWN' };
    console.log(JSON.stringify(observation));
    throw new Error('Acquisition tool refused or exceeded its bound');
  }
  return result.stdout;
}
