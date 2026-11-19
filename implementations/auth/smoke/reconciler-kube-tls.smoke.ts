/** The default Kube transport trusts only the configured CA and bounds every call.
 *  Run: pnpm smoke:reconciler-kube-tls */
import { deferred } from "./_deferred.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { KubeSecretStore } from "../src/kube-secret-store.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

// Test-only PKI: a cluster CA, a leaf it signed for 127.0.0.1, and an unrelated CA. No CA key is kept.
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/kube-tls/${name}`, import.meta.url));
const CA = fixture("ca.pem");
const OTHER_CA = fixture("other-ca.pem");
const tls = { cert: readFileSync(fixture("leaf.pem")), key: readFileSync(fixture("leaf-key.pem")) };

const VALUE = "held-value";
const secret = JSON.stringify({ metadata: { resourceVersion: "1" }, data: { k: Buffer.from(VALUE).toString("base64") } });

async function listen(server: Server): Promise<string> {
  const { promise, resolve } = deferred<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const store = (apiBase: string, caPath: string, timeoutMs = 5_000) =>
  new KubeSecretStore({ apiBase, namespace: "cotal-control", name: "reconciler-credentials", token: async () => "t", caPath, timeoutMs });

const answering = createServer(tls, (req, res) => {
  assert.equal(req.headers.authorization, "Bearer t");
  res.writeHead(200, { "content-type": "application/json" }).end(secret);
});
const hung = createServer(tls, () => { /* accepts the request and never answers */ });
const answeringBase = await listen(answering);
const hungBase = await listen(hung);

try {
  await cell("the store reads through a server signed by the configured CA", async () => {
    assert.equal(await store(answeringBase, CA).get("k"), VALUE);
  });

  await cell("the store refuses the same server under an unrelated CA", async () => {
    let error: unknown;
    try { await store(answeringBase, OTHER_CA).get("k"); } catch (e) { error = e; }
    assert.ok(error instanceof Error, "the store connected to a server its CA did not sign");
    const code = (error as NodeJS.ErrnoException).code ?? "";
    assert.match(`${code} ${error.message}`, /certificate|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i);
  });

  await cell("a server that never answers times out at the call bound", async () => {
    const started = performance.now();
    let error: unknown;
    try { await store(hungBase, CA, 300).get("k"); } catch (e) { error = e; }
    const elapsed = performance.now() - started;
    assert.ok(error instanceof Error, "a call to a hung server resolved");
    assert.match(error.message, /timed out after 300 ms/);
    assert.ok(elapsed >= 250 && elapsed < 5_000, `the bound did not hold: ${Math.round(elapsed)} ms`);
  });
} finally {
  answering.closeAllConnections();
  hung.closeAllConnections();
  answering.close();
  hung.close();
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
