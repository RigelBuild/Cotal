/** A failing or hung Secret write never stops auth; it retries with backoff, and stop leaves no timer or later write.
 *  Run: pnpm smoke:reconciler-fault */
import { deferred } from "./_deferred.js";
import assert from "node:assert/strict";
import { createSpaceAuth, credsClaims, mintCreds, mintLifecycleUid, newIdentity, type SecretStore } from "@cotal-ai/core";
import {
  keepReconcilerCredentialRenewed,
  RECONCILER_CREDS_KEY,
  reconcilerRecordKey,
  secretRecordStore,
  startReconcilerCredential,
  type ReconcilerRecord,
} from "../src/reconciler-credential.js";
import { KubeSecretStore } from "../src/kube-secret-store.js";

type FakeTimer = { at: number; fn: () => void; cleared: boolean; unref: () => void };

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

// A controllable clock and timer queue. Timers fire only when `advance` moves the clock past them.
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let clock = 1_700_000_000_000;
const timers: FakeTimer[] = [];
Date.now = () => clock;
globalThis.setTimeout = ((fn: () => void, ms?: number) => {
  const t: FakeTimer = { at: clock + Number(ms ?? 0), fn, cleared: false, unref() {} };
  timers.push(t);
  return t as unknown as NodeJS.Timeout;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((t?: FakeTimer) => { if (t) t.cleared = true; }) as unknown as typeof clearTimeout;

/** Fire every timer due within `ms`, in order. Work a timer starts runs on; callers await its event. */
async function advance(ms: number): Promise<void> {
  const end = clock + ms;
  for (;;) {
    const due = timers.filter((t) => !t.cleared && t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (due === undefined) break;
    clock = due.at;
    due.cleared = true;
    due.fn();
    await flushMicrotasks();
  }
  clock = end;
}
const liveTimers = (): number => timers.filter((t) => !t.cleared).length;
/** One macrotask turn: every queued microtask has run when it resolves. */
function flushMicrotasks(): Promise<void> {
  const { promise, resolve } = deferred<void>();
  setImmediate(resolve);
  return promise;
}

/** Bound an awaited event with a real timer, so a missing event fails the cell instead of hanging. */
async function within<T>(event: Promise<T>, what: string, ms = 10_000): Promise<T> {
  const guard = deferred<never>();
  const timer = realSetTimeout(() => guard.reject(new Error(`${what}: no event within ${ms} ms`)), ms);
  try { return await Promise.race([event, guard.promise]); } finally { realClearTimeout(timer); }
}

/** A Secret store that fails its first `failures` writes, then accepts them. `nextWrite` resolves on
 *  the next write attempt with whether it landed. */
class FlakyStore implements SecretStore {
  readonly values = new Map<string, string>();
  writes = 0;
  private waiters: Array<(landed: boolean) => void> = [];
  constructor(public failures: number) {}
  nextWrite(): Promise<boolean> {
    const { promise, resolve } = deferred<boolean>();
    this.waiters.push(resolve);
    return promise;
  }
  async get(key: string) { return this.values.get(key); }
  async put(key: string, value: string) {
    this.writes++;
    const landed = this.failures === 0;
    if (landed) this.values.set(key, value);
    else this.failures--;
    // Waiters wake on a microtask queued before this call settles, so they may run before the caller resumes.
    queueMicrotask(() => { for (const w of this.waiters.splice(0)) w(landed); });
    if (!landed) throw new Error("secret write failed: HTTP 503");
  }
  async create(key: string, value: string) {
    if (this.values.has(key)) return false;
    await this.put(key, value);
    return true;
  }
  async delete(key: string) { this.values.delete(key); }
}

/** A Secret store whose writes block until the test releases them. */
class GatedStore extends FlakyStore {
  readonly entered = deferred<void>();
  readonly release = deferred<boolean>();
  override async put(key: string, value: string) {
    this.entered.resolve();
    if (!(await this.release.promise)) { this.writes++; throw new Error("secret write failed: HTTP 503"); }
    await super.put(key, value);
  }
}

const auth = await createSpaceAuth("fault");
const caller = { owner: `p_${"a".repeat(26)}`, actor: "reconciler", uid: mintLifecycleUid() };
const logs: string[] = [];
let logWaiters: Array<{ re: RegExp; resolve: () => void }> = [];
const log = (line: string) => {
  logs.push(line);
  const hit = logWaiters.filter((w) => w.re.test(line));
  logWaiters = logWaiters.filter((w) => !w.re.test(line));
  for (const w of hit) w.resolve();
};
const nextLog = (re: RegExp): Promise<void> => {
  const { promise, resolve } = deferred<void>();
  logWaiters.push({ re, resolve });
  return promise;
};
const start = (secrets: SecretStore, backing: SecretStore) =>
  startReconcilerCredential({ space: "fault", auth, owner: caller.owner, secrets, records: secretRecordStore(backing, "fault", RECONCILER_CREDS_KEY), log });

/** Start, let the first attempt land its write, and return the stop handle. */
async function startIssued(secrets: FlakyStore, backing: SecretStore): Promise<() => void> {
  const stop = start(secrets, backing);
  const wrote = secrets.nextWrite();
  await advance(0);
  assert.equal(await within(wrote, "first issue"), true, "the first issue did not land");
  // Let the issue finish arming its renewal; the write wakes the waiter before `hold` runs.
  await flushMicrotasks();
  return stop;
}

await cell("a failing first issue never throws to the caller and is retried in the background", async () => {
  const secrets = new FlakyStore(2);
  const stop = start(secrets, new FlakyStore(0));
  assert.equal(typeof stop, "function", "the start did not return its stop handle");
  for (let i = 0; i < 2; i++) {
    const wrote = secrets.nextWrite();
    const retried = nextLog(/retrying with backoff/);
    await advance(i === 0 ? 0 : 60_000);
    assert.equal(await within(wrote, `attempt ${i + 1}`), false, `attempt ${i + 1} should fail`);
    await within(retried, `retry log ${i + 1}`);
    assert.equal(liveTimers(), 1, `no retry armed after failure ${i + 1}`);
  }
  const wrote = secrets.nextWrite();
  await advance(60_000);
  assert.equal(await within(wrote, "third attempt"), true, "the background retry never wrote the credential");
  assert.ok(secrets.values.get(RECONCILER_CREDS_KEY));
  stop();
  assert.equal(liveTimers(), 0, "a timer is still armed after stop");
});

await cell("a restart with a credential past 75% renews it for the same triple and nkey", async () => {
  const backing = new FlakyStore(0);
  const secrets = new FlakyStore(0);
  (await startIssued(secrets, backing))();
  const records = secretRecordStore(backing, "fault", RECONCILER_CREDS_KEY);
  const before = await records.load();
  assert.ok(before, "no record after first start");
  const creds = secrets.values.get(RECONCILER_CREDS_KEY);
  assert.ok(creds, "no credential after first start");
  const claims = credsClaims(creds);
  clock = (claims.iat! + Math.ceil(0.8 * (claims.exp! - claims.iat!))) * 1000;
  const second = await startIssued(secrets, backing);
  second();
  const after = await records.load();
  const renewed = secrets.values.get(RECONCILER_CREDS_KEY);
  assert.ok(renewed);
  assert.notEqual(renewed, creds, "the restart did not renew a credential past 75%");
  assert.deepEqual(after?.caller, before.caller, "the restart changed the caller triple");
  assert.equal(after?.identity.id, before.identity.id, "the restart changed the nkey");
  assert.equal(credsClaims(renewed).sub, claims.sub, "the renewed credential has another nkey");
});

await cell("a stop during an in-flight first write that lands arms no renewal timer", async () => {
  const secrets = new GatedStore(0);
  const stop = start(secrets, new FlakyStore(0));
  await advance(0);
  await within(secrets.entered.promise, "first write entered");
  stop();
  const wrote = secrets.nextWrite();
  secrets.release.resolve(true);
  assert.equal(await within(wrote, "in-flight write"), true);
  await flushMicrotasks();
  assert.equal(liveTimers(), 0, "a renewal timer was armed after stop");
  await advance(24 * 3600 * 1000);
  assert.equal(secrets.writes, 1, "a write happened after stop");
});

await cell("a stop during an in-flight first write that fails arms no retry", async () => {
  const secrets = new GatedStore(0);
  const stop = start(secrets, new FlakyStore(0));
  await advance(0);
  await within(secrets.entered.promise, "first write entered");
  stop();
  const failed = nextLog(/retrying with backoff/);
  secrets.release.resolve(false);
  await within(failed, "failure log");
  assert.equal(liveTimers(), 0, "a retry timer was armed after stop");
  await advance(24 * 3600 * 1000);
  assert.equal(secrets.values.get(RECONCILER_CREDS_KEY), undefined, "a write landed after stop");
});

await cell("stop cancels the renewal timer, so no write happens after the clock advances", async () => {
  const secrets = new FlakyStore(0);
  const stop = await startIssued(secrets, new FlakyStore(0));
  assert.equal(liveTimers(), 1, "no renewal timer was armed after issue");
  stop();
  const writes = secrets.writes;
  assert.equal(liveTimers(), 0, "a timer is still armed after stop");
  await advance(24 * 3600 * 1000);
  assert.equal(secrets.writes, writes, "a renewal wrote after stop");
});

await cell("a failed renew retries after backoff and succeeds with the same sub", async () => {
  const secrets = new FlakyStore(0);
  const stop = await startIssued(secrets, new FlakyStore(0));
  const first = secrets.values.get(RECONCILER_CREDS_KEY);
  assert.ok(first);
  secrets.failures = 1;
  const failedLog = nextLog(/renewal failed/);
  // Advance to just past the 75% point (18h), so the backoff retry (at most 1 s) is still pending.
  const failedWrite = secrets.nextWrite();
  await advance(18 * 3600 * 1000);
  assert.equal(await within(failedWrite, "renewal at 75%"), false, "the renewal did not run at 75%");
  await within(failedLog, "renewal failure log");
  assert.equal(liveTimers(), 1, "no backoff retry was armed after the failed renewal");
  const retried = secrets.nextWrite();
  await advance(60_000);
  assert.equal(await within(retried, "renewal retry"), true, "the renewal retry did not land");
  const renewed = secrets.values.get(RECONCILER_CREDS_KEY);
  assert.ok(renewed);
  assert.notEqual(renewed, first, "the retry did not re-mint");
  assert.equal(credsClaims(renewed).sub, credsClaims(first).sub, "the retried renew changed the nkey");
  stop();
});

await cell("a held credential under another key is treated as due and reissued from the record", async () => {
  const backing = new FlakyStore(0);
  const secrets = new FlakyStore(0);
  (await startIssued(secrets, backing))();
  const record = await secretRecordStore(backing, "fault", RECONCILER_CREDS_KEY).load() as ReconcilerRecord;
  const other = await createSpaceAuth("fault-other");
  secrets.values.set(RECONCILER_CREDS_KEY, await mintCreds(other, newIdentity(), "reconciler", {
    principal: { owner: caller.owner, actor: caller.actor }, lifecycleUid: caller.uid,
    reconciler: { owner: caller.owner, actor: caller.actor, uid: caller.uid },
  }));
  (await startIssued(secrets, backing))();
  assert.equal(credsClaims(secrets.values.get(RECONCILER_CREDS_KEY)!).sub, record.identity.id, "the foreign credential was kept");
});

await cell("an unreadable credential in the Secret is treated as due, not as a startup error", async () => {
  const backing = new FlakyStore(0);
  const secrets = new FlakyStore(0);
  (await startIssued(secrets, backing))();
  const record = await secretRecordStore(backing, "fault", RECONCILER_CREDS_KEY).load() as ReconcilerRecord;
  secrets.values.set(RECONCILER_CREDS_KEY, "not a credential");
  (await startIssued(secrets, backing))();
  assert.equal(credsClaims(secrets.values.get(RECONCILER_CREDS_KEY)!).sub, record.identity.id, "the unreadable credential was not replaced");
});

await cell("the record save never overwrites an existing record with another triple or key", async () => {
  const backing = new FlakyStore(0);
  (await startIssued(new FlakyStore(0), backing))();
  const records = secretRecordStore(backing, "fault", RECONCILER_CREDS_KEY);
  const before = backing.values.get(reconcilerRecordKey("fault", RECONCILER_CREDS_KEY));
  assert.ok(before, "no record was saved");
  let error: unknown;
  try { await records.save({ caller: { ...caller, uid: mintLifecycleUid() }, identity: newIdentity() }); } catch (e) { error = e; }
  assert.match(String(error), /conflict|already/, "the save did not refuse");
  assert.equal(backing.values.get(reconcilerRecordKey("fault", RECONCILER_CREDS_KEY)), before, "the recorded triple changed");
});

await cell("a Kube call that never answers times out at its bound and counts as a failure", async () => {
  const called = deferred<void>();
  const hung = new KubeSecretStore({
    apiBase: "https://kube.test",
    namespace: "cotal-control",
    name: "reconciler-credentials",
    token: async () => "t",
    timeoutMs: 50,
    transport: () => { called.resolve(); return new Promise(() => {}); },
  });
  let settled = false;
  const pending = hung.put("k", "v").then(() => "resolved", (e: unknown) => e).finally(() => { settled = true; });
  await within(called.promise, "transport call");
  await advance(49);
  assert.equal(settled, false, "the hung call settled before its bound");
  await advance(1);
  const outcome = await within(pending, "bounded call");
  assert.ok(outcome instanceof Error, "a hung write resolved");
  assert.match(outcome.message, /timed out after 50 ms/);
});

await cell("keepReconcilerCredentialRenewed renews at 75% and stops re-arming once stopped", async () => {
  const renewals: number[] = [];
  // Each renewal returns a fresh 24h lifetime, so the next arm sits 18h ahead.
  const authority = { issue: async () => { throw new Error("unused"); }, renew: async () => { renewals.push(clock); const now = Math.floor(clock / 1000); return { iat: now, exp: now + 86_400 }; } };
  const iat = Math.floor(clock / 1000);
  const live = keepReconcilerCredentialRenewed(authority, caller, { iat, exp: iat + 86_400 }, () => {});
  await advance(86_400 * 1000);
  assert.deepEqual(renewals, [(iat + 0.75 * 86_400) * 1000], "the renewal did not fire once at 75%");
  live();
  const stopped = keepReconcilerCredentialRenewed(authority, caller, { iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 86_400 }, () => {});
  stopped();
  await advance(86_400 * 1000);
  assert.equal(renewals.length, 1, "a renewal fired after stop");
});

Date.now = realNow;
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
