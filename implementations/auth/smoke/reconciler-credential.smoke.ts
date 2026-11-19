/**
 * The auth service issues and renews the `reconciler` credential for one fixed caller triple, writes
 * it to one Secret, and never writes signer material. Run: pnpm smoke:reconciler-credential
 */
import assert from "node:assert/strict";
import { createSpaceAuth, credsClaims, identityFromCreds, mintLifecycleUid } from "@cotal-ai/core";
import {
  createReconcilerCredentialAuthority,
  RECONCILER_CREDS_KEY,
  type ReconcilerCaller,
  type ReconcilerRecord,
  type ReconcilerRecordStore,
} from "../src/reconciler-credential.js";
import { KubeSecretStore, RECONCILER_SECRET_NAME, RECONCILER_SECRET_NAMESPACE, type KubeTransport } from "../src/kube-secret-store.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}
async function rejects(name: string, fn: () => Promise<unknown>, re: RegExp) {
  await cell(name, async () => {
    let error: unknown;
    try { await fn(); } catch (e) { error = e; }
    assert.ok(error instanceof Error, "expected a refusal");
    assert.match(error.message, re);
  });
}

const API = "https://kube.test";
const SECRET_URL = `${API}/api/v1/namespaces/cotal-control/secrets/reconciler-credentials`;
type KubeBody = { metadata?: { resourceVersion?: string }; data?: Record<string, string | null> };
const writes: Array<{ method: string; url: string; body: KubeBody }> = [];
// The Secret exists empty, as the cluster manifests provision it, beside a key another writer owns.
const OTHER_KEY = "serve-bundle";
const OTHER_VALUE = Buffer.from("owned by another writer").toString("base64");
let stored: Record<string, string> = { [OTHER_KEY]: OTHER_VALUE };
// A stateful API server that serves only get and merge patch on the one Secret.
const transport: KubeTransport = async (url, call) => {
  if (url !== SECRET_URL) throw new Error(`unexpected ${call.method} ${url}`);
  if (call.method === "GET") return { status: 200, body: JSON.stringify({ metadata: { resourceVersion: "1" }, data: stored }) };
  if (call.method === "PATCH" && call.body !== undefined) {
    assert.equal(call.headers["content-type"], "application/merge-patch+json");
    const body = JSON.parse(call.body) as KubeBody;
    writes.push({ method: "PATCH", url, body });
    for (const [k, v] of Object.entries(body.data ?? {})) {
      if (v === null) delete stored[k];
      else stored = { ...stored, [k]: v };
    }
    return { status: 200, body: "{}" };
  }
  throw new Error(`verb ${call.method} is not granted to auth`);
};

const auth = await createSpaceAuth("demo");
let record: ReconcilerRecord | undefined;
const records: ReconcilerRecordStore = {
  load: async () => record,
  save: async (next) => { record = next; },
};
const secrets = new KubeSecretStore({
  apiBase: API,
  namespace: RECONCILER_SECRET_NAMESPACE,
  name: RECONCILER_SECRET_NAME,
  token: async () => "test-token",
  transport,
});
const authority = createReconcilerCredentialAuthority({ auth, secrets, records });
const caller: ReconcilerCaller = { owner: "local", actor: "reconciler", uid: mintLifecycleUid() };
let issuedSub: string | undefined;

await cell("issue writes the credential to the Secret and records the caller triple", async () => {
  const first = await authority.issue(caller);
  assert.deepEqual(writes.map((w) => w.method), ["PATCH"]);
  assert.deepEqual(record?.caller, caller);
  assert.ok(first.exp > Math.floor(Date.now() / 1000));
  const held = await secrets.get(RECONCILER_CREDS_KEY);
  assert.ok(held, "no Secret data written");
  issuedSub = credsClaims(held).sub;
  assert.ok(issuedSub);
});

await cell("renew for the same caller triple keeps the nkey and the recorded uid", async () => {
  await authority.renew(caller);
  assert.deepEqual(writes.map((w) => w.method), ["PATCH", "PATCH"]);
  const held = await secrets.get(RECONCILER_CREDS_KEY);
  assert.ok(held);
  assert.equal(credsClaims(held).sub, issuedSub);
  assert.equal(record?.caller.uid, caller.uid);
});

await rejects("renew refuses a caller triple with another uid", () => authority.renew({ ...caller, uid: mintLifecycleUid() }), /caller triple/);
await rejects("renew refuses a caller triple with another actor", () => authority.renew({ ...caller, actor: "other" }), /caller triple/);

await cell("a refused renew writes no Secret", () => {
  assert.equal(writes.length, 2);
});

await cell("the Secret holds only the user JWT and user nkey seed, never signer material", async () => {
  const text = await secrets.get(RECONCILER_CREDS_KEY);
  assert.ok(text);
  assert.match(text, /BEGIN NATS USER JWT/);
  assert.match(text, /BEGIN USER NKEY SEED/);
  assert.equal(identityFromCreds(text).id, credsClaims(text).sub);
  assert.ok(!text.includes(auth.account.signingSeed), "account signing seed leaked into the Secret");
  assert.ok(!text.includes(auth.sys.signingSeed as string), "system signing seed leaked into the Secret");
  assert.doesNotMatch(text, /BEGIN (ACCOUNT|OPERATOR) NKEY SEED|\bS[AO][A-Z2-7]{50,}/);
});

await cell("auth patches only its own key on the fixed Secret and keeps the other writer's key", () => {
  assert.deepEqual(writes.map((w) => `${w.method} ${w.url}`), [`PATCH ${SECRET_URL}`, `PATCH ${SECRET_URL}`]);
  for (const w of writes) assert.deepEqual(Object.keys(w.body.data ?? {}), [RECONCILER_CREDS_KEY], "a patch touched another key");
  assert.equal(stored[OTHER_KEY], OTHER_VALUE, "the other writer's key changed");
});

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
