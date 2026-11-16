import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import { IdentityRetirementBackoff, IdentityRetirementDriver } from "../src/identity/retirements.js";
import { IdentityStore } from "../src/identity/store.js";

const backoff = new IdentityRetirementBackoff();
const uid = "identity-a";
assert.deepEqual(Array.from({ length: 10 }, () => backoff.nextDelay(uid)), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
assert.equal(backoff.nextDelay(uid), 300_000, "retry delay stays capped at five minutes");
assert.equal(backoff.nextDelay("identity-b"), 1_000, "identities have independent retry state");
backoff.reset(uid);
assert.equal(backoff.nextDelay(uid), 1_000, "successful retirement resets the retry sequence");
console.log("PASS identity retirement backoff doubles, caps at five minutes, and resets after success");

const root = mkdtempSync(join(tmpdir(), "cotal-identity-retirement-driver-"));
const auth = await createSpaceAuth("retirement-driver-smoke");
const store = new IdentityStore(root, "retirement-driver-smoke", "manager");
const first = store.reserve("first", "minter", 1);
const second = store.reserve("second", "minter", 2);
store.latchRetirement(first.name, first.minter, first.lifecycleUid);
store.latchRetirement(second.name, second.minter, second.lifecycleUid);
const attempts = new Map<string, number>();
const recordExpiry = store.recordRetirementExpiry.bind(store);
store.recordRetirementExpiry = (name, minter, lifecycleUid) => {
  const count = (attempts.get(lifecycleUid) ?? 0) + 1;
  attempts.set(lifecycleUid, count);
  if (count === 1) throw new Error(`injected expiry failure for ${name}`);
  return recordExpiry(name, minter, lifecycleUid);
};
const renewalFlight = Promise.withResolvers<never>();
setTimeout(() => renewalFlight.reject(new Error("injected slow renewal failure")), 1_100);
const driver = new IdentityRetirementDriver(() => ({
  identityStore: store,
  auth,
  identityMintFlights: new Map(),
  identityRenewFlights: new Map([[second.lifecycleUid, renewalFlight.promise]]),
  staticReconcileStopping: false,
  managerLifecycleUid: "manager-lifecycle",
  managerInstanceId: "manager-instance",
  space: "retirement-driver-smoke",
  retiredPrincipals: new Set(),
  identityRetirementClock: () => Date.now(),
  withLifecycleExecutor: async () => { throw new Error("unexpected lifecycle executor call"); },
  withIssuer: async () => { throw new Error("unexpected issuer call"); },
}));
try {
  await driver.recheckIdentityRetirements();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && store.list().some((row) => row.retiredAt === undefined))
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok((attempts.get(first.lifecycleUid) ?? 0) >= 2, "a retry timer that fires during a sweep must rerun its skipped row");
  assert.ok((attempts.get(second.lifecycleUid) ?? 0) >= 2, "a second failed row must be retried without the credential-renew tick");
  assert.ok(store.list().every((row) => row.retiredAt !== undefined), "both failed rows must eventually retire");
  assert.ok(store.list().every((row) => row.retirementError === undefined), "successful retirement clears the persisted error");
  console.log("PASS retirement driver reruns two failed rows when a retry timer joins an active sweep");
} finally {
  driver.stop();
  rmSync(root, { recursive: true, force: true });
}
