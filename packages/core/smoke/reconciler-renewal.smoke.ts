/**
 * The reconciler credential renews at exactly 75% of its lifetime, and the auth service owns that
 * renewal. The shared renewal window is unchanged for every other caller. Run: pnpm smoke:reconciler-renewal
 */
import assert from "node:assert/strict";
import { credentialLifetime, STANDING_RENEWABLE_TTL_SEC } from "../src/provision.js";
import { armFixedRenewal, armRenewal } from "../src/renewal.js";

type FakeTimer = { at: number; fn: () => void; cleared: boolean; unref: () => void };

let pass = 0;
let fail = 0;
function cell(name: string, fn: () => void) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

const LIFE_MS = STANDING_RENEWABLE_TTL_SEC * 1000;
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let clock = 1_700_000_000_000;
let timers: FakeTimer[] = [];
Date.now = () => clock;
globalThis.setTimeout = ((fn: () => void, ms?: number) => {
  const t: FakeTimer = { at: clock + Number(ms ?? 0), fn, cleared: false, unref() {} };
  timers.push(t);
  return t as unknown as NodeJS.Timeout;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((t?: FakeTimer) => { if (t) t.cleared = true; }) as unknown as typeof clearTimeout;

try {
  cell("reconciler is a 24h standing credential renewed by the auth service", () => {
    const l = credentialLifetime("reconciler");
    assert.equal(l.class, "standing-renewable");
    assert.equal(l.defaultTtlSeconds, STANDING_RENEWABLE_TTL_SEC);
    assert.equal(l.renewalOwner, "auth-service");
  });

  cell("armFixedRenewal arms one timer at exactly 75% of the lifetime", () => {
    clock = 1_700_000_000_000;
    timers = [];
    const issuedAt = clock;
    let renewals = 0;
    armFixedRenewal(issuedAt, issuedAt + LIFE_MS, () => { renewals += 1; });
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.at, issuedAt + 0.75 * LIFE_MS);
    assert.equal(renewals, 0);
    clock = timers[0]!.at;
    timers[0]!.fn();
    assert.equal(renewals, 1);
  });

  cell("the 75% point is fixed, not drawn, across arms with the same lifetime", () => {
    clock = 1_700_000_000_000;
    timers = [];
    const issuedAt = clock;
    armFixedRenewal(issuedAt, issuedAt + LIFE_MS, () => {});
    armFixedRenewal(issuedAt, issuedAt + LIFE_MS, () => {});
    assert.equal(timers.length, 2);
    assert.equal(timers[0]!.at, issuedAt + 0.75 * LIFE_MS);
    assert.equal(timers[1]!.at, issuedAt + 0.75 * LIFE_MS);
  });

  cell("the shared armRenewal window stays within 50-80% for other callers", () => {
    clock = 1_700_000_000_000;
    timers = [];
    const issuedAt = clock;
    const cancel = armRenewal("shared-window-smoke", issuedAt, issuedAt + LIFE_MS, () => {});
    assert.equal(timers.length, 1);
    assert.ok(timers[0]!.at >= issuedAt + 0.5 * LIFE_MS && timers[0]!.at <= issuedAt + 0.8 * LIFE_MS, `at=${timers[0]!.at}`);
    cancel();
  });
} finally {
  Date.now = realNow;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
