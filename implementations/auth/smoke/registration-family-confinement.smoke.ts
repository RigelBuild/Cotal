import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";
import { createSpaceAuth, epAuthBucket, epgateKey, eprepairKey, isReachable, managerRegistrationFamilySubject, mintCreds, mintLifecycleUid, newIdentity, recordsBucket, remoteManagerActors, serverConfig, setupSpaceStreams, standaloneConnectOpts, RegistrationFamilyRefusedError } from "@cotal-ai/core";
import { openPublishDenialWatch } from "../../../packages/core/src/endpoint-publish-denial.js";
import { Kvm } from "@nats-io/kv";
import { openAuthAuthorityPlane } from "../src/index.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { requestManagerRegistrationFamily, requestManagerRegistrationRead, remoteManagerRegistrationProof, serveIssuanceGateKv } from "@cotal-ai/core";
import { actionContext, bindGoal, createGoal, commitGoalResult } from "@cotal-ai/core";
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
  // The mint-race fixture below advances the gate from its prepared epoch 0 to epoch 1.
  const currentGateProcessEpoch = 1;
  let rewriteGateDuringMint = false;
  const plane = await openAuthAuthorityPlane({ server: servers, space, dir, identityRoot: dir, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, log: () => {}, probeManagerMint: async () => {
    if (!rewriteGateDuringMint) return;
    rewriteGateDuringMint = false;
    const provisioner = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }), tls: false }), reconnect: false });
    try {
      const kv = await new Kvm(provisioner).open(epAuthBucket(space));
      await kv.put(epgateKey("manager", instanceId), new TextEncoder().encode(JSON.stringify({ state: "open", generation: 1, processEpoch: currentGateProcessEpoch, registrationRevision: 1, nameAuthorityRevision: 0, principal: `${owner}.${remoteManagerActors(instanceId).serve}` })));
    } finally { await provisioner.close(); }
  } });
  const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  const prepare = { v: 1 as const, kind: "manager-service-authority" as const, operation: "prepare" as const, space, actor: "cli", instanceId, managerLifecycleUid: mintLifecycleUid(), requestId: `req${mintLifecycleUid()}`, identities };
  await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: prepare });
  rewriteGateDuringMint = true;
  await assert.rejects(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: { ...prepare, requestId: `req${mintLifecycleUid()}` } }), /manager issuance gate changed while credentials were being minted/);
  assert.equal(rewriteGateDuringMint, false);
  console.log("  ✓ gate movement after signing refuses without releasing credentials");
  const pinnedRequest = (operation: "session" | "transferReader", targetInstanceId = instanceId, proofOwner = owner, sessionEpoch = currentGateProcessEpoch) => {
    const common = {
      ...prepare,
      operation,
      instanceId: targetInstanceId,
      requestId: `req${mintLifecycleUid()}`,
      registrationProof: remoteManagerRegistrationProof(proofOwner, {
        space, instanceId: targetInstanceId, lifecycleUid: prepare.managerLifecycleUid, identities,
      }),
    };
    return operation === "session"
      ? { ...common, session: { id: newIdentity().id, endpoint: "manager", sessionId: "owner-bind", epoch: sessionEpoch, exp: Math.floor(Date.now() / 1000) + 60 } }
      : { ...common, transferReader: { id: newIdentity().id } };
  };
  const setManagerGate = async (state: "open" | "frozen" | "retired", gateOwner = owner) => {
    const provisioner = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId } }), tls: false }), reconnect: false });
    try {
      const kv = await new Kvm(provisioner).open(epAuthBucket(space));
      const op = state === "retired" ? { opId: mintLifecycleUid(), kind: "retirement" } : { opId: mintLifecycleUid(), kind: "takeover" };
      await kv.put(epgateKey("manager", instanceId), new TextEncoder().encode(JSON.stringify({
        state, generation: 1, processEpoch: currentGateProcessEpoch, registrationRevision: 1,
        nameAuthorityRevision: 0, principal: `${gateOwner}.${remoteManagerActors(instanceId).serve}`,
        ...(state === "open" ? {} : { op }),
      })));
    } finally { await provisioner.close(); }
  };
  for (const operation of ["session", "transferReader"] as const) {
    const material = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: pinnedRequest(operation) });
    assert.ok(operation === "session" ? material.credentials.sessionServing : material.credentials.transferReader);
    console.log(`  ✓ same owner can issue ${operation}`);
    await assert.rejects(
      plane.issueManagerServiceAuthority({ owner: `u_${"b".repeat(26)}`, scope: ["supervise"], request: pinnedRequest(operation, instanceId, `u_${"b".repeat(26)}`) }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "permission-denied" && error.message === "manager instance belongs to another owner",
    );
    console.log(`  ✓ another owner cannot issue ${operation} credentials for this instance`);
    await assert.rejects(
      plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: pinnedRequest(operation, mintLifecycleUid()) }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "failed-precondition" && /no current open manager gate/.test(error.message),
    );
    console.log(`  ✓ ${operation} refuses an instance without a gate`);
  }
  const staleSession = pinnedRequest("session", instanceId, owner, currentGateProcessEpoch - 1);
  await assert.rejects(
    plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: staleSession }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "conflict" && /serve epoch 0 is stale; current is 1/.test(error.message),
  );
  console.log("  ✓ session issuance refuses a stale serving epoch");
  for (const state of ["frozen", "retired"] as const) {
    await setManagerGate(state);
    for (const operation of ["session", "transferReader"] as const) {
      await assert.rejects(
        plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: pinnedRequest(operation) }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "failed-precondition" && /no current open manager gate/.test(error.message),
      );
      console.log(`  ✓ ${operation} refuses a ${state} manager gate`);
    }
  }
  const foreignOwner = `u_${"c".repeat(26)}`;
  await setManagerGate("open", foreignOwner);
  const activationArtifacts = [{}];
  const activation = {
    ...prepare,
    operation: "activate" as const,
    requestId: `req${mintLifecycleUid()}`,
    registrationProof: remoteManagerRegistrationProof(owner, {
      space, instanceId, lifecycleUid: prepare.managerLifecycleUid, identities,
    }, activationArtifacts),
    contractArtifacts: activationArtifacts,
  };
  await assert.rejects(
    plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: activation }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "permission-denied" && error.message === "manager instance belongs to another owner",
  );
  console.log("  ✓ activation refuses an instance gate held by another owner");
  await setManagerGate("open");
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
  try {
    for (const [name, subject, data] of [
      ["durable push create denied", `$JS.API.CONSUMER.CREATE.KV_${epAuthBucket(space)}.exporter`, JSON.stringify({ stream_name: `KV_${epAuthBucket(space)}`, config: { durable_name: "exporter", deliver_subject: "export.data" } })],
      ["peer consumer delete denied", `$JS.API.CONSUMER.DELETE.KV_${epAuthBucket(space)}.peer`, ""],
      ["raw auth stream read denied", `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`, JSON.stringify({ last_by_subj: `$KV.${epAuthBucket(space)}.${epgateKey("manager", mintLifecycleUid())}` })],
      ["raw records stream read denied", `$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`, "{}"],
      ["direct records read denied", `$JS.API.DIRECT.GET.KV_${recordsBucket(space)}.$KV.${recordsBucket(space)}.govern.manager`, ""],
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
      const denied = new Promise<Error>((resolve, reject) => {
        const sub = foreign.subscribe(`${subject}.reply.*`, { callback: error => { if (error) { sub.unsubscribe(); resolve(error); } } });
        void foreign.flush().catch(reject);
      });
      const error = await Promise.race([denied, delay(5000).then(() => { throw new Error("subscription denial not observed"); })]);
      assert.match(error.message, /permissions violation/i);
      console.log("  ✓ another owner cannot subscribe to reply leaf");
    } finally { await foreign.close(); }
    const register = (evict: (principals: readonly string[]) => Promise<boolean[]>) => registerRemoteManagerAuthority({ space, server: servers, owner, instanceId, serveActor: remoteManagerActors(instanceId).serve, prepareCreds: creds, tlsRequired: false, evict });
    await assert.rejects(requestManagerRegistrationRead(nc, space, owner, instanceId, { kind: "read", key: epgateKey("manager", mintLifecycleUid()) }),
      error => error instanceof RegistrationFamilyRefusedError);
    console.log("  ✓ closed read refuses another instance gate");
    await setManagerGate("retired");
    await assert.rejects(requestManagerRegistrationFamily(nc, space, owner, instanceId, 1000),
      error => error instanceof RegistrationFamilyRefusedError);
    await setManagerGate("open");
    console.log("  ✓ family scan refuses a retired gate");
    const noGateInstance = mintLifecycleUid();
    const noGateActor = remoteManagerActors(noGateInstance).executor;
    const noGateCreds = await mintCreds(auth, newIdentity(), "remote-manager", {
      principal: { owner, actor: noGateActor }, remoteManager: { instanceId: noGateInstance, owner, actor: noGateActor } });
    const noGateClient = await connect({ servers, ...standaloneConnectOpts({ creds: noGateCreds, tls: false }), reconnect: false });
    try {
      await assert.rejects(requestManagerRegistrationRead(noGateClient, space, owner, noGateInstance,
        { kind: "read", key: eprepairKey("manager", noGateInstance) }),
        error => error instanceof RegistrationFamilyRefusedError);
      await assert.rejects(requestManagerRegistrationFamily(noGateClient, space, owner, noGateInstance, 1000),
        error => error instanceof RegistrationFamilyRefusedError);
      console.log("  ✓ absent non-gate read and family scan are authorization refusals");
    } finally { await noGateClient.close(); }
    const goalIdentity = newIdentity();
    const goalCreds = await mintCreds(auth, goalIdentity, "goal-writer", { principal: { owner, actor: remoteManagerActors(instanceId).goalWriter }, goalWriter: { endpoint: "manager", remoteManager: { owner, instanceId } } });
    const goal = await connect({ servers, ...standaloneConnectOpts({ creds: goalCreds, tls: false }), reconnect: false });
    try {
      const subject = `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`;
      const watch = openPublishDenialWatch(goal, subject, error => error, "goal writer raw auth read");
      try {
        goal.publish(subject, new TextEncoder().encode("{}"));
        const denied = await Promise.race([watch.denied.catch(error => error), delay(5000).then(() => { throw new Error("goal writer denial not observed"); })]);
        assert.match(denied.message, /permissions violation/i);
        console.log("  ✓ goal writer raw auth stream read denied");
      } finally { watch.release(); }
      assert.ok(await requestManagerRegistrationRead(goal, space, owner, instanceId, { kind: "read", key: epgateKey("manager", instanceId) }));
      console.log("  ✓ goal writer closed gate read succeeds");
      const caller = { owner, actor: "cli", uid: mintLifecycleUid() };
      const ref = { endpoint: "manager", caller, goalId: "confinegoal" };
      const ctx = await actionContext(goal, space);
      await bindGoal(ctx, ref, "sha256:aa");
      await createGoal(ctx, ref, { fingerprint: "sha256:aa", command: "spawn", caller: { id: `${owner}.cli`, lifecycleUid: caller.uid }, requestId: "req-confine", sourceSeq: 1, acceptedAt: 1000 });
      assert.ok((await commitGoalResult(ctx, { ref, now: 1500, cause: "complete", state: "succeeded" })).won);
      console.log("  ✓ remote goal writer commits a goal");
    } finally { await goal.close(); }
    await register(async principals => principals.map(() => true));
    console.log("  ✓ first registration succeeds after prepare creates its gate");
    const kv = await new Kvm(nc).open(epAuthBucket(space));
    const read = async (key: string) => {
      const result = await requestManagerRegistrationRead(nc, space, owner, instanceId, { kind: "read", key });
      if (typeof result === "number") throw new Error("unexpected read result");
      return result;
    };
    const gate = serveIssuanceGateKv(kv, space, { endpoint: "manager", instanceId, read });
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
    const second = mintLifecycleUid();
    await gate.stage({ credentialId: second, credentialKey: "", holderPrincipal, endpoint: "manager", lifecycleUid: instanceId, sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 3600, generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0 });
    await register(async principals => principals.map(() => true));
    assert.equal((await requestManagerRegistrationFamily(nc, space, owner, instanceId)).find(row => row.credentialId === second)?.state, "revoked");
    console.log("  ✓ second takeover recreates the deleted repair cursor");
  } finally { await nc.close(); await plane.close(); }
} finally { await killAndAwaitExit(server); release(); }
