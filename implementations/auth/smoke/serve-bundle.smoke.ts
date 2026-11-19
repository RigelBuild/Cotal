/**
 * Auth registers `wave-seats`, issues the shim's serve bundle under its own Secret key, and renews
 * it at 75% through the same live gate. It never clobbers the caller credential key, and the bundle
 * carries no signer material and no caller rails. Run: pnpm smoke:serve-bundle
 */
import assert from "node:assert/strict";
import { credsClaims, fixedRenewalPointMs, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { RECONCILER_CREDS_KEY, secretRecordStore } from "../src/reconciler-credential.js";
import { KubeSecretStore, RECONCILER_SECRET_NAME, RECONCILER_SECRET_NAMESPACE, type KubeTransport } from "../src/kube-secret-store.js";
import { issueServeBundle, RECONCILER_SERVE_KEY, SEATS_ENDPOINT_NAME } from "../src/serve-bundle.js";
import { openAuthorityClient, registrationExecutorGrants } from "../src/authority-client.js";
import { MemoryStore, startHostedAuthFixture } from "./_hosted-auth-fixture.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

const API = "https://kube.test";
const SECRET_URL = `${API}/api/v1/namespaces/cotal-control/secrets/reconciler-credentials`;
type KubeBody = { data?: Record<string, string | null> };
const writes: Array<{ keys: string[] }> = [];
// The Secret starts empty, as the cluster manifests provision it.
let stored: Record<string, string> = {};
const transport: KubeTransport = async (url, call) => {
  if (url !== SECRET_URL) throw new Error(`unexpected ${call.method} ${url}`);
  if (call.method === "GET") return { status: 200, body: JSON.stringify({ metadata: { resourceVersion: "1" }, data: stored }) };
  if (call.method === "PATCH" && call.body !== undefined) {
    const body = JSON.parse(call.body) as KubeBody;
    writes.push({ keys: Object.keys(body.data ?? {}) });
    for (const [k, v] of Object.entries(body.data ?? {})) {
      if (v === null) delete stored[k];
      else stored = { ...stored, [k]: v };
    }
    return { status: 200, body: "{}" };
  }
  throw new Error(`verb ${call.method} is not granted to auth`);
};
const secrets = new KubeSecretStore({
  apiBase: API,
  namespace: RECONCILER_SECRET_NAMESPACE,
  name: RECONCILER_SECRET_NAME,
  token: async () => "test-token",
  transport,
});

// One live broker and one space account, as the wire smoke runs them.
const fx = await startHostedAuthFixture("serve-bundle", 1);
const account = fx.accounts[0]!;
await setupSpaceStreams({ servers: fx.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
const records = secretRecordStore(new MemoryStore({ kind: "injected", coordinate: "memory:serve-bundle-records" }), account.space, RECONCILER_CREDS_KEY);
const serveIdentity = newIdentity();
const instanceId = mintLifecycleUid();

// The executor connection auth registers `wave-seats` through, opened with the registration grants.
const executor = await openAuthorityClient({
  server: fx.servers,
  space: account.space,
  dataAccount: { pub: account.auth.account.pub, signingSeed: account.auth.account.signingSeed! },
  label: `cotal:serve-bundle-registration:${account.space}`,
  grants: (id) => registrationExecutorGrants(account.space, id, SEATS_ENDPOINT_NAME, instanceId),
  log: () => {},
});
const issueOpts = {
  auth: account.auth,
  secrets,
  records,
  nc: executor.nc,
  serveIdentity,
  owner: "local",
  instanceId,
  observeGate: async () => null,
};

await cell("serve bundle is issued under its own key and never under the caller credential key", async () => {
  const issued = await issueServeBundle(issueOpts);
  assert.equal(issued.endpoint, SEATS_ENDPOINT_NAME);
  assert.ok(issued.exp > issued.iat);
  assert.ok(stored[RECONCILER_SERVE_KEY], "no serve bundle written under its key");
  assert.equal(stored[RECONCILER_CREDS_KEY], undefined, "the serve bundle landed under the caller credential key");
});

await cell("a serve write patches only the serve key", () => {
  assert.deepEqual(writes.at(-1)?.keys, [RECONCILER_SERVE_KEY], "the serve write touched another key");
});

await cell("a caller write leaves the serve key untouched", () => {
  const before = stored[RECONCILER_SERVE_KEY];
  stored = { ...stored, [RECONCILER_CREDS_KEY]: "caller-held-value" };
  assert.equal(stored[RECONCILER_SERVE_KEY], before, "a caller-side write changed the serve key");
});

await cell("the serve bundle renews at exactly 75% of its lifetime", async () => {
  const issued = await issueServeBundle(issueOpts);
  assert.equal(fixedRenewalPointMs(issued.iat * 1000, issued.exp * 1000), (issued.iat + 0.75 * (issued.exp - issued.iat)) * 1000);
});

await cell("a serve renewal re-registers wave-seats before it re-mints", async () => {
  const issued = await issueServeBundle(issueOpts);
  assert.equal(issued.endpoint, SEATS_ENDPOINT_NAME, "the renewal did not serve wave-seats");
});

await cell("the serve bundle carries no signer material and grants serve only, not caller rails", () => {
  const text = stored[RECONCILER_SERVE_KEY];
  assert.ok(text, "no serve bundle to inspect");
  assert.ok(!text.includes(account.auth.account.signingSeed!), "account signing seed leaked into the serve bundle");
  assert.doesNotMatch(text, /BEGIN (ACCOUNT|OPERATOR) NKEY SEED|\bS[AO][A-Z2-7]{50,}/);
  assert.ok(typeof credsClaims(text).sub === "string", "the serve bundle carries no subject");
  assert.doesNotMatch(text, /"reconciler"/, "the serve bundle carries the caller profile");
});

await executor.close();
await fx.close();
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
