import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a private seat root that a distinct agent uid can traverse through its temporary base. */
export function custodySeatRoot(prefix: string): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  if (process.env.COTAL_SEAT_AGENT_UID !== undefined) chmodSync(base, 0o711);
  const root = join(base, "seats");
  mkdirSync(root, { mode: 0o700 });
  process.env.COTAL_SEAT_ROOT = root;
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const CUSTODY_ENV_KEYS: Readonly<Record<string, true>> = {
  COTAL_SEAT_CGROUP_DELEGATED: true,
  COTAL_SEAT_AGENT_UID: true,
};

/** Keep only the delegated seat-custody settings from ambient COTAL_* values. The returned map
 * contains those settings only, for test subprocesses that otherwise use a narrower env allow-list. */
export function scrubAmbientCotalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const custodyEnv: Record<string, string> = {};
  for (const key of Object.keys(CUSTODY_ENV_KEYS)) {
    const value = env[key];
    if (value !== undefined) custodyEnv[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("COTAL_") && !Object.hasOwn(CUSTODY_ENV_KEYS, key)) delete env[key];
  }
  return custodyEnv;
}
