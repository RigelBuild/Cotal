/**
 * Unit cells for reading a pre-minted agent credential (`spawn-creds.ts`): the lifecycle check
 * (match, mismatch, missing) and the capability derivation (spawn, run, admin, none). Offline: every
 * credential is minted in-process from a throwaway space, so no broker is involved.
 *
 * Run: tsx implementations/cli/smoke/spawn-creds-grant.smoke.ts
 */
import { createSpaceAuth, credsClaims, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { credentialCapabilities, readCredentialGrant } from "../src/commands/spawn-creds.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const SPACE = "credsgrant";
const auth = await createSpaceAuth(SPACE);
const mint = async (capabilities?: string[]) => {
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const creds = await mintCreds(auth, identity, "agent", { lifecycleUid, ...(capabilities ? { capabilities } : {}) });
  return { id: identity.id, lifecycleUid, creds, allow: credsClaims(creds).nats?.pub?.allow ?? [] };
};
const refusal = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

console.log("readCredentialGrant: the lifecycle the credential was minted for");
{
  const m = await mint(["spawn"]);
  const grant = readCredentialGrant(m.creds, SPACE, m.lifecycleUid);
  check("match: returns the JWT subject as the id", grant.id === m.id, grant);
  check("match: returns the credential's capabilities", grant.capabilities.join(",") === "spawn", grant);

  const wrong = mintLifecycleUid();
  const mismatch = refusal(() => readCredentialGrant(m.creds, SPACE, wrong));
  check("mismatch: another uid is refused", mismatch !== undefined, mismatch);
  check("mismatch: the refusal names the uid and the durable", !!mismatch?.includes(wrong) && !!mismatch?.includes("dm_"), mismatch);

  const otherSpace = refusal(() => readCredentialGrant(m.creds, "elsewhere", m.lifecycleUid));
  check("mismatch: the right uid in another space is refused", otherSpace !== undefined, otherSpace);

  const missing = refusal(() => readCredentialGrant("not a creds file", SPACE, m.lifecycleUid));
  check("missing: a file with no JWT is refused", missing !== undefined, missing);
}

console.log("credentialCapabilities: reversed from the minted rows");
{
  const caps = async (minted?: string[]) => {
    const m = await mint(minted);
    return credentialCapabilities(m.allow, SPACE, m.id, m.lifecycleUid);
  };
  const spawn = await caps(["spawn"]);
  check("spawn: a spawn credential holds spawn", spawn.includes("spawn") && !spawn.includes("admin"), spawn);
  const run = await caps(["run"]);
  check("run: a run credential holds run", run.includes("run") && !run.includes("admin"), run);
  const admin = await caps(["admin"]);
  check("admin: an admin credential holds admin", admin.includes("admin"), admin);
  const none = await caps();
  check("empty: a plain agent credential holds none", none.length === 0, none);

  const m = await mint(["spawn"]);
  const foreign = credentialCapabilities(m.allow, SPACE, m.id, mintLifecycleUid());
  check("empty: rows for another lifecycle count for nothing", foreign.length === 0, foreign);
  check("empty: no rows at all yield none", credentialCapabilities([], SPACE, m.id, m.lifecycleUid).length === 0);
}

console.log(`\nSPAWN-CREDS GRANT ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exit(1);
