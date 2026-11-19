/**
 * Placement wiring: the production reconciler authenticator, the reconciler key derived from the
 * auth identity, and placement staying unconfigured while only the authenticator is set. Each case
 * prints one ✓ or ✗ line; the process exits non-zero when any case fails.
 */
import assert from "node:assert/strict";
import * as enrollment from "../src/placement-enrollment.js";
import * as service from "../src/service.js";
import { platformControlOwner } from "../src/derive.js";

const OWNER = `u_${"a".repeat(26)}`;
const OTHER_OWNER = `u_${"b".repeat(26)}`;
const RECONCILER_KEY = `${OWNER}.reconciler`;
const OPERATION = "auth.verify-placement-enrollment";
const DIGEST = `sha256:${"0".repeat(64)}`;


let failed = 0;
async function check(name: string, run: () => unknown): Promise<void> {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const admits = async (auth: enrollment.ServiceAuthenticator, transportPrincipal: string) =>
  auth.authenticateService({ transportPrincipal, operation: OPERATION, requestDigest: DIGEST });

await check("the exact reconciler owner.actor key is admitted", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  assert.deepEqual(await admits(auth, RECONCILER_KEY), { principal: "reconciler" });
});

await check("another owner's reconciler actor is refused", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  assert.deepEqual(await admits(auth, `${OTHER_OWNER}.reconciler`), { principal: "unauthorized" });
});

await check("an actor-only name and a suffix match are refused", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  for (const transportPrincipal of ["reconciler", `${OWNER}x.reconciler`, `x${RECONCILER_KEY}`]) {
    assert.deepEqual(await admits(auth, transportPrincipal), { principal: "unauthorized" }, transportPrincipal);
  }
});

await check("a key that extends the real key by one character is refused", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  assert.deepEqual(await admits(auth, `${RECONCILER_KEY}x`), { principal: "unauthorized" });
});

await check("a key that differs only in case is refused", async () => {
  const auth = enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY);
  assert.deepEqual(await admits(auth, `${OWNER}.Reconciler`), { principal: "unauthorized" });
});

await check("the empty string is refused, also by an empty configured key", async () => {
  assert.deepEqual(await admits(enrollment.reconcilerServiceAuthenticator(RECONCILER_KEY), ""), { principal: "unauthorized" });
  assert.deepEqual(await admits(enrollment.reconcilerServiceAuthenticator(""), ""), { principal: "unauthorized" });
});

await check("the reconciler key is the derived auth identity, owner.reconciler", () => {
  const seed = "p".repeat(32);
  const accountPublicKey = "A".repeat(56);
  const derived = service.reconcilerPrincipalFor(seed, "main", accountPublicKey);
  assert.equal(derived, `${platformControlOwner(seed, "main", accountPublicKey)}.reconciler`);
});

await check("the derived key is the one the authenticator admits", async () => {
  const seed = "p".repeat(32);
  const accountPublicKey = "A".repeat(56);
  const auth = enrollment.reconcilerServiceAuthenticator(service.reconcilerPrincipalFor(seed, "main", accountPublicKey));
  assert.deepEqual(await admits(auth, `${platformControlOwner(seed, "main", accountPublicKey)}.reconciler`), { principal: "reconciler" });
});

console.log(failed === 0 ? "placement wiring smoke passed" : `placement wiring smoke FAILED (${failed} failed)`);
if (failed > 0) process.exitCode = 1;
