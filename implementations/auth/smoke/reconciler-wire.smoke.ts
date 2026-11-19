/** Auth issues the reconciler credential into the Secret when enabled, reuses it on restart, and writes nothing when off.
 *  Run: pnpm smoke:reconciler-wire */
import { deferred } from "./_deferred.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credsClaims, mintCreds, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { platformControlOwner } from "../src/derive.js";
import {
  RECONCILER_CREDS_KEY,
  reconcilerRecordKey,
  secretRecordStore,
  startReconcilerCredential,
  type ReconcilerRecord,
} from "../src/reconciler-credential.js";
import { runAuthService, type AuthDaemonLifecycle } from "../src/service.js";
import { ensurePinnedIdp, loadOwnerSecret } from "../src/store.js";
import { MemoryStore, startHostedAuthFixture, type HostedAuthAccount } from "./_hosted-auth-fixture.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

const IDP = "http://127.0.0.1:1/api/auth";

const fx = await startHostedAuthFixture("reconciler-wire", 2);
for (const account of fx.accounts)
  await setupSpaceStreams({ servers: fx.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
function accountAt(i: number): HostedAuthAccount {
  const account = fx.accounts.at(i);
  if (account === undefined) throw new Error(`fixture has no account ${i}`);
  return account;
}
const enabled = accountAt(0);
const disabled = accountAt(1);
const secret = new MemoryStore({ kind: "injected", coordinate: "memory:reconciler-secret" });

/** Start the auth service through runAuthService and resolve once its planes are open. The account
 *  holds only the projection the daemon loads (ServiceKeys), as a hosted store does. */
async function startService(account: HostedAuthAccount, extra: Partial<AuthDaemonLifecycle>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "reconciler-wire-"));
  ensurePinnedIdp(userAuthStateDir(root, account.space), IDP);
  const { promise, resolve, reject } = deferred<void>();
  const lifecycle: AuthDaemonLifecycle = { root, quiet: true, onReady: () => resolve(), onClosed: () => {}, ...extra };
  runAuthService({ values: { space: account.space, server: fx.servers }, positionals: [], raw: [] }, account.store, lifecycle).catch(reject);
  await promise;
}

async function callerTriple(account: HostedAuthAccount): Promise<ReconcilerRecord> {
  const raw = await account.store.get(reconcilerRecordKey(account.space, RECONCILER_CREDS_KEY));
  assert.ok(raw, "no caller triple recorded in auth's own store");
  return JSON.parse(raw) as ReconcilerRecord;
}

/** Await `event`, failing after `ms` so a missing event fails the cell instead of hanging it. */
async function within<T>(event: Promise<T>, what: string, ms = 10_000): Promise<T> {
  const guard = deferred<never>();
  const timer = setTimeout(() => guard.reject(new Error(`${what}: no event within ${ms} ms`)), ms);
  try { return await Promise.race([event, guard.promise]); } finally { clearTimeout(timer); }
}

// The reconciler Secret, wrapped so each write is an event.
let onSecretPut: (key: string) => void = () => {};
const watchedSecret = {
  get: (key: string) => secret.get(key),
  put: async (key: string, value: string) => { await secret.put(key, value); onSecretPut(key); },
  create: (key: string, value: string) => secret.create(key, value),
  delete: (key: string) => secret.delete(key),
};
// The restart cell's write count, read again after later cells so a write after stop is caught.
let restartPutsAfterStop: () => number = () => 0;

await cell("a started service writes the credential to the reconciler Secret and records the caller triple", async () => {
  const wrote = deferred<void>();
  onSecretPut = (key) => { if (key === RECONCILER_CREDS_KEY) wrote.resolve(); };
  await startService(enabled, { reconcilerSecret: { namespace: "cotal-control", name: "reconciler-credentials", store: watchedSecret } });
  await within(wrote.promise, "first issue write");
  onSecretPut = () => {};
  const creds = await secret.get(RECONCILER_CREDS_KEY);
  assert.ok(creds, "no credential written to the reconciler Secret");
  assert.deepEqual([...secret.values.keys()], [RECONCILER_CREDS_KEY], "the Secret holds more than the user credential");
  const record = await callerTriple(enabled);
  const ownerSecret = await loadOwnerSecret(enabled.store, enabled.space);
  assert.ok(ownerSecret, "owner secret missing");
  assert.equal(record.caller.owner, platformControlOwner(ownerSecret, enabled.space, enabled.accountPublicKey));
  assert.equal(record.caller.actor, "reconciler");
  assert.match(record.caller.uid, /^[a-z0-9]{26,32}$/);
  assert.equal(credsClaims(creds).sub, record.identity.id);
  assert.ok(!creds.includes(enabled.auth.account.signingSeed), "account signing seed leaked into the Secret");
});

await cell("a restart reuses the recorded triple and nkey and issues no second identity", async () => {
  const before = await enabled.store.get(reconcilerRecordKey(enabled.space, RECONCILER_CREDS_KEY));
  const creds = await secret.get(RECONCILER_CREDS_KEY);
  assert.ok(before && creds, "the first start left nothing to restart from");
  const ownerSecret = await loadOwnerSecret(enabled.store, enabled.space);
  assert.ok(ownerSecret, "owner secret missing");
  // A correct restart holds the current credential: it arms the renewal at 75% and never writes. A
  // wrong restart writes first. The cell ends when the 75% timer is armed, so a write before it fails.
  let restartPuts = 0;
  const watched = {
    get: (key: string) => secret.get(key),
    put: async (key: string, value: string) => { restartPuts++; await secret.put(key, value); },
    create: (key: string, value: string) => secret.create(key, value),
    delete: (key: string) => secret.delete(key),
  };
  const claims = credsClaims(creds);
  assert.ok(typeof claims.iat === "number" && typeof claims.exp === "number", "the held credential has no bounded lifetime");
  const renewAtMs = (claims.iat + 0.75 * (claims.exp - claims.iat)) * 1000;
  const armed = deferred<void>();
  const realSetTimeout = globalThis.setTimeout;
  // Watch for the one timer whose delay lands on the held credential's 75% point.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    if (Math.abs(Date.now() + Number(ms ?? 0) - renewAtMs) < 5_000) armed.resolve();
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
  let stop: () => void = () => {};
  try {
    stop = startReconcilerCredential({
      space: enabled.space,
      auth: enabled.auth,
      owner: platformControlOwner(ownerSecret, enabled.space, enabled.accountPublicKey),
      secrets: watched,
      records: secretRecordStore(enabled.store, enabled.space, RECONCILER_CREDS_KEY),
      log: () => {},
    });
    await within(armed.promise, "renewal armed at 75% of the held credential");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    stop();
  }
  assert.equal(restartPuts, 0, "the restart wrote the Secret before it held the credential");
  restartPutsAfterStop = () => restartPuts;
  assert.equal(await enabled.store.get(reconcilerRecordKey(enabled.space, RECONCILER_CREDS_KEY)), before, "the restart rewrote the recorded triple");
  assert.equal(await secret.get(RECONCILER_CREDS_KEY), creds, "the restart re-issued the credential");
});

await cell("with the option off, nothing is written", async () => {
  await startService(disabled, {});
  assert.equal(await disabled.store.get(reconcilerRecordKey(disabled.space, RECONCILER_CREDS_KEY)), undefined, "a caller triple was recorded with the option off");
});

// Runs after a full service start, long after any in-flight mint from the restart cell would land.
await cell("the stopped restart never writes the Secret later", () => {
  assert.equal(restartPutsAfterStop(), 0, "the restart wrote the Secret after stop");
});

console.log(`${pass} passed, ${fail} failed`);
// The started services keep their broker connections; exit here rather than closing the broker, whose
// drop would end each service with a non-zero exit.
process.exit(fail > 0 ? 1 : 0);
