/** Run after building core: pnpm smoke:issued-observe:live (needs nats-server). The disclosure read
 *  against a throwaway broker: it answers for an active generation whose source is dead, which
 *  resolve refuses, and it refuses a prepared, retired or expired one as resolve does. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  ensureIssuedStores, importNativeSubjectPermissions, issuedBucket, issuedHorizon, mintAcceptedToken, mintGeneration, openIssuedStore,
  acceptedBucket, acceptedKey, writeAcceptedRow,
  type IssuedAuthorityRef, type IssuedEvidence, type PreparedIssuance,
} from "../src/issued-authority.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { createSpaceAuth } from "../src/provision.js";
import { credentialIdOf, epAuthBucket, mintLifecycleUid, mintPublicSeatUserJwt, newIdentity } from "../src/index.js";

function evidenceForGeneration(actor: string, generation: string): IssuedEvidence {
  const ref: IssuedAuthorityRef = { space: "observe", owner: "local", actor, uid: "a".repeat(26), generation };
  const source = { space: "observe", bucket: "cotal_auth_observe", key: `cred.${ref.uid}` };
  const permissions = importNativeSubjectPermissions({ pub: { allow: [`cotal.observe.ep.v1.one.registry.endpoints.local.${actor}.${ref.uid}.${generation}.*`] }, sub: { deny: [">"] } });
  return { version: 1, ref, sources: [source], permissions, jwtExpiresAt: issuedHorizon(generation), jwtClaimsDigest: "c".repeat(64) };
}

if (process.argv[2] === "stage-child") {
  const port = process.argv[3];
  const generation = process.argv[4];
  if (port === undefined || generation === undefined) throw new Error("stage-child requires a port and generation");
  const childNc = await connect({ servers: `nats://127.0.0.1:${port}` });
  try {
    const childKvm = new Kvm(childNc);
    const childStore = openIssuedStore(await childKvm.open(issuedBucket("observe")), await jetstreamManager(childNc), "observe");
    const handle = await childStore.stage(evidenceForGeneration("restart_prepared", generation));
    process.stdout.write(JSON.stringify(handle));
  } finally {
    await childNc.close();
  }
  process.exit(0);
}
let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  const servers = `nats://127.0.0.1:${port}`;
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  const space = "observe";
  await ensureIssuedStores(jsm, kvm, space);
  const store = openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space);
  const now = Math.floor(Date.now() / 1000);
  const evidenceFor = (actor: string, extra: Partial<IssuedEvidence> = {}): IssuedEvidence => {
    const ref: IssuedAuthorityRef = { space, owner: "local", actor, uid: "a".repeat(26), generation: mintGeneration(now + 3600) };
    const source = { space, bucket: `cotal_auth_${space}`, key: `cred.${ref.uid}` };
    const permissions = importNativeSubjectPermissions({ pub: { allow: [`cotal.${space}.ep.v1.one.registry.endpoints.local.${actor}.${ref.uid}.${ref.generation}.*`] }, sub: { deny: [">"] } });
    return { version: 1, ref, sources: [source], permissions, ...extra };
  };
  await check("public seat retry repairs accepted row after activation interruption", async () => {
    const auth = await createSpaceAuth(space);
    const identity = newIdentity();
    const uid = mintLifecycleUid();
    const issued = { generation: mintGeneration(now + 3600), acceptedToken: mintAcceptedToken() };
    const accepted = await kvm.open(acceptedBucket(space));
    let credentialId = "";
    let interrupted = false;
    const interruptedAccepted = new Proxy(accepted, {
      get(target, property, receiver) {
        if (property === "create") return async () => { interrupted = true; throw new Error("injected accepted-row interruption"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const source = { space, bucket: epAuthBucket(space), key: `cred.${uid}` };
    const options = {
      name: "seat", principal: { owner: "local", actor: identity.id }, lifecycleUid: uid,
      issuedAt: now, expiresAt: now + 1800, issued,
      issuance: { mode: "issue" as const, store, accepted: interruptedAccepted, sources: [source],
        finalize: async (id: string) => { credentialId = id; } },
    };
    await assert.rejects(() => mintPublicSeatUserJwt(auth, identity.id, options), /injected accepted-row interruption/);
    assert.ok(interrupted && credentialId);
    assert.equal(await accepted.get(acceptedKey(issued.acceptedToken)), null);
    const replay = await mintPublicSeatUserJwt(auth, identity.id, { ...options, issuance: { ...options.issuance, accepted } });
    assert.equal(credentialIdOf(replay.jwt), credentialId);
    assert.ok(await accepted.get(acceptedKey(issued.acceptedToken)));
    const again = await mintPublicSeatUserJwt(auth, identity.id, { ...options, issuance: { ...options.issuance, accepted } });
    assert.equal(again.jwt, replay.jwt);
  });
  await check("JWT time and claims replay preserve first iat and reject claim changes", async () => {
    const base = evidenceFor("timestamp_replay");
    const evidence: IssuedEvidence = { ...base, jwtExpiresAt: issuedHorizon(base.ref.generation), jwtClaimsDigest: "a".repeat(64) };
    const first = await store.stage(evidence);
    assert.ok(Number.isSafeInteger(first.issuedAt) && first.issuedAt! > 0);
    const replay = await store.stage({ ...evidence, issuedAt: first.issuedAt! + 1 });
    assert.deepEqual(replay, first);
    await assert.rejects(() => store.stage({ ...evidence, jwtClaimsDigest: "b".repeat(64) }), /different issued evidence/);
    await assert.rejects(() => store.stage({ ...evidence, jwtExpiresAt: evidence.jwtExpiresAt! - 1 }), /different issued evidence/);
    await assert.rejects(() => store.stage({ ...evidence, jwtClaimsDigest: "A".repeat(64) }), /lowercase SHA-256/);
  });
  await check("terminal issuance state refuses an otherwise identical replay", async () => {
    const evidence = evidenceFor("terminal_replay");
    await store.stage(evidence);
    assert.equal(await store.retire(evidence.ref), "aborted");
    await assert.rejects(() => store.stage(evidence), /is aborted/);
  });
  await check("identical staging replays the same prepared durable revision", async () => {
    const evidence = evidenceFor("replay_identical");
    const first = await store.stage(evidence);
    const replay = await openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space).stage(evidence);
    assert.deepEqual(replay, first);
    await assert.rejects(() => store.observe(evidence.ref), /is prepared/);
  });

  await check("active issuance replay skips finalizer and keeps accepted-row retry safe", async () => {
    const evidence = evidenceFor("replay_active");
    const staged = await store.stage(evidence);
    await store.release(staged, async () => {});
    const replay = await store.stage(evidence);
    assert.equal(replay.state, "active");
    await store.release(replay, async () => { throw new Error("active replay ran the finalizer"); });
  });
  await check("accepted-row replay accepts only the same token and reference", async () => {
    const evidence = evidenceFor("accepted_replay");
    const accepted = await kvm.open(`cotal_accepted_${space}`);
    const acceptedToken = mintAcceptedToken();
    await writeAcceptedRow(accepted, acceptedToken, evidence.ref);
    await writeAcceptedRow(accepted, acceptedToken, evidence.ref);
    const other = evidenceFor("accepted_mismatch");
    await assert.rejects(() => writeAcceptedRow(accepted, acceptedToken, other.ref), /different or terminal row/);
  });
  await check("staging refuses a mismatched record and does not alter prepared evidence", async () => {
    const evidence = evidenceFor("replay_mismatch");
    const prepared = await store.stage(evidence);
    const mismatch: IssuedEvidence = {
      ...evidence,
      permissions: importNativeSubjectPermissions({ pub: { deny: [">"] }, sub: { deny: [">"] } }),
    };
    await assert.rejects(() => store.stage(mismatch), /different issued evidence/);
    const replay = await store.stage(evidence);
    assert.deepEqual(replay, prepared);
  });

  await check("a restarted issuer releases durable prepared state without an in-memory handle", async () => {
    const evidence = evidenceFor("restart_prepared");
    const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "stage-child", String(port), evidence.ref.generation], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const decoded: unknown = JSON.parse(child.stdout);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)
      || !("key" in decoded) || typeof decoded.key !== "string"
      || !("revision" in decoded) || typeof decoded.revision !== "number"
      || !("digest" in decoded) || typeof decoded.digest !== "string"
      || !("state" in decoded) || decoded.state !== "prepared"
      || !("issuedAt" in decoded) || typeof decoded.issuedAt !== "number"
      || !("jwtExpiresAt" in decoded) || typeof decoded.jwtExpiresAt !== "number"
      || !("jwtClaimsDigest" in decoded) || typeof decoded.jwtClaimsDigest !== "string"
      || !("ref" in decoded) || decoded.ref === null || typeof decoded.ref !== "object"
      || !("space" in decoded.ref) || decoded.ref.space !== evidence.ref.space
      || !("owner" in decoded.ref) || decoded.ref.owner !== evidence.ref.owner
      || !("actor" in decoded.ref) || decoded.ref.actor !== evidence.ref.actor
      || !("uid" in decoded.ref) || decoded.ref.uid !== evidence.ref.uid
      || !("generation" in decoded.ref) || decoded.ref.generation !== evidence.ref.generation)
      throw new Error("staging child returned an invalid durable issuance handle");
    const durable: PreparedIssuance = {
      key: decoded.key,
      ref: evidence.ref,
      revision: decoded.revision,
      digest: decoded.digest,
      state: "prepared",
      issuedAt: decoded.issuedAt,
      jwtExpiresAt: decoded.jwtExpiresAt,
      jwtClaimsDigest: decoded.jwtClaimsDigest,
    };
    const restartedStore = openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space);
    let finalized = false;
    await restartedStore.release(durable, async () => { finalized = true; });
    assert.equal(finalized, true);
    assert.equal((await restartedStore.observe(evidence.ref)).evidence.ref.generation, evidence.ref.generation);
  });
  await check("active durable replay restores the accepted row after a simulated lost reply", async () => {
    const evidence = evidenceFor("accepted_crash");
    const staged = await store.stage(evidence);
    await store.release(staged, async () => {});
    const acceptedToken = mintAcceptedToken();
    const accepted = await kvm.open(`cotal_accepted_${space}`);
    await writeAcceptedRow(accepted, acceptedToken, evidence.ref);
    const activeReplay = await openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space).stage(evidence);
    await openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space).release(activeReplay, async () => {
      throw new Error("active replay reran finalizer after accepted-row interruption");
    });
    await writeAcceptedRow(accepted, acceptedToken, evidence.ref);
  });



  await check("observe answers an active generation whose source is dead, which resolve refuses", async () => {
    const evidence = evidenceFor("dead_source");
    await store.release(await store.stage(evidence), async () => {});
    await assert.rejects(() => store.resolve(evidence.ref, async () => false), /no longer live/);
    const observed = await store.observe(evidence.ref);
    assert.deepEqual(observed.evidence, evidence);
  });

  await check("observe refuses a prepared generation", async () => {
    const evidence = evidenceFor("prepared");
    await store.stage(evidence);
    await assert.rejects(() => store.observe(evidence.ref), /is prepared/);
  });

  await check("observe refuses a retired generation", async () => {
    const evidence = evidenceFor("retired");
    await store.release(await store.stage(evidence), async () => {});
    await store.retire(evidence.ref);
    await assert.rejects(() => store.observe(evidence.ref), /is revoked/);
  });

  await check("observe refuses expired evidence and a generation past its horizon", async () => {
    const evidence = evidenceFor("expiring", { sources: [], expiresAt: now + 5 });
    await store.release(await store.stage(evidence), async () => {});
    await assert.rejects(() => store.observe(evidence.ref, () => now + 10), /expired at/);
    await assert.rejects(() => store.observe(evidence.ref, () => now + 7200), /expired at/);
  });

  await check("observe refuses a generation with no evidence", async () => {
    await assert.rejects(() => store.observe(evidenceFor("absent").ref));
  });
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
