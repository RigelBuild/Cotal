import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { createSpaceAuth, epAuthBucket, isReachable, managerRegistrationFamilySubject, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig, setupSpaceStreams, standaloneConnectOpts } from "@cotal-ai/core";
import { openPublishDenialWatch } from "../../../packages/core/src/endpoint-publish-denial.js";
import { Kvm } from "@nats-io/kv";
import { openAuthAuthorityPlane } from "../src/index.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { requestManagerRegistrationFamily, serveIssuanceGateKv } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const space = `confine${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space), port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`, dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(server, dir);
try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const instanceId = mintLifecycleUid(), owner = `u_${"a".repeat(26)}`, actor = remoteManagerActors(instanceId).executor;
  const creds = await mintCreds(auth, newIdentity(), "remote-manager", { principal: { owner, actor }, remoteManager: { instanceId, owner, actor } });
  const plane = await openAuthAuthorityPlane({ server: servers, space, dir, identityRoot: dir, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, log: () => {} });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  try {
    for (const [name, subject, data] of [
      ["durable push create denied", `$JS.API.CONSUMER.CREATE.KV_${epAuthBucket(space)}.exporter`, JSON.stringify({ stream_name: `KV_${epAuthBucket(space)}`, config: { durable_name: "exporter", deliver_subject: "export.data" } })],
      ["peer consumer delete denied", `$JS.API.CONSUMER.DELETE.KV_${epAuthBucket(space)}.peer`, ""],
      ["other instance scan publish denied", managerRegistrationFamilySubject(space, owner, mintLifecycleUid()), ""],
    ]) {
      const watch = openPublishDenialWatch(nc, subject, error => error, name);
      try {
        nc.publish(subject, new TextEncoder().encode(data));
        const result = await Promise.race([watch.denied.catch(error => error), delay(1500).then(() => null)]);
        assert.ok(result instanceof Error && /permissions violation/i.test(result.message), name);
        console.log(`  ✓ ${name}`);
      } finally { watch.release(); }
    }
    const otherOwner = `u_${"b".repeat(26)}`;
    const foreignCreds = await mintCreds(auth, newIdentity(), "remote-manager", { principal: { owner: otherOwner, actor }, remoteManager: { instanceId, owner: otherOwner, actor } });
    const foreign = await connect({ servers, ...standaloneConnectOpts({ creds: foreignCreds, tls: false }), reconnect: false });
    try {
      const subject = managerRegistrationFamilySubject(space, owner, instanceId);
      const watch = openPublishDenialWatch(foreign, subject, error => error, "foreign owner scan");
      try {
        foreign.publish(subject);
        const denied = await Promise.race([watch.denied.catch(error => error), delay(1500).then(() => null)]);
        assert.ok(denied instanceof Error && /permissions violation/i.test(denied.message));
        console.log("  ✓ another owner cannot publish to same instance scan");
      } finally { watch.release(); }
      let denied = false;
      const sub = foreign.subscribe(`${subject}.reply.*`, { callback: error => { if (error) denied = true; } });
      await foreign.flush().catch(() => { denied = true; });
      await delay(350);
      sub.unsubscribe();
      assert.ok(denied, "foreign owner reply subscription denied");
      console.log("  ✓ another owner cannot subscribe to reply leaf");
    } finally { await foreign.close(); }
    const register = (evict: (principals: readonly string[]) => Promise<boolean[]>) => registerRemoteManagerAuthority({ space, server: servers, owner, instanceId, serveActor: remoteManagerActors(instanceId).serve, prepareCreds: creds, tlsRequired: false, evict });
    await register(async principals => principals.map(() => true));
    const kv = await new Kvm(nc).open(epAuthBucket(space));
    const gate = serveIssuanceGateKv(kv, space, { endpoint: "manager", instanceId });
    const credentialId = mintLifecycleUid(), holderPrincipal = `${owner}.${remoteManagerActors(instanceId).serve}`;
    await gate.stage({ credentialId, credentialKey: "", holderPrincipal, endpoint: "manager", lifecycleUid: instanceId, sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 3600, generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0 });
    const family = await requestManagerRegistrationFamily(nc, space, owner, instanceId);
    assert.equal(family.length, 1); assert.equal(family[0]?.credentialId, credentialId);
    console.log("  ✓ own scan returns exact family");
    let evicted: readonly string[] = [];
    await register(async principals => { evicted = principals; return principals.map(() => true); });
    assert.ok(evicted.includes(holderPrincipal));
    assert.equal((await requestManagerRegistrationFamily(nc, space, owner, instanceId))[0]?.state, "revoked");
    console.log("  ✓ registration revokes and verifies eviction of non-empty family");
  } finally { await nc.close(); await plane.close(); }
} finally { await killAndAwaitExit(server); release(); }
