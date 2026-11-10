/** Endpoint-family enumeration under the actual instance-bound executor profile.
 * Seed through the shipped gate adapter. Count native requests, not elapsed time, for the scaling
 * assertion. The truncated-iterator cell wraps a real consumer whose bind count is still real.
 * FAMILY_SCAN_EVIDENCE_DIR retains the owned broker state and non-secret measurements for a run.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, type PushConsumer } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { openPublishDenialWatch } from "../../../packages/core/src/endpoint-publish-denial.js";
import type { Bucket } from "@nats-io/kv/internal";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  createBrokerAuth, createSpaceAccountAuth, mintCreds, mintPublicUserJwt, credsFromJwt, remoteManagerActors, newIdentity, serverConfig, setupSpaceStreams,
  isReachable, standaloneConnectOpts, mintLifecycleUid, principalKey, DEV_OWNER, epAuthBucket, recordsBucket,
  epgateKey, epcredRowKey, provisionEndpointGateOpen, serveIssuanceGateKv, endpointRegistrationBarrier,
  IncompleteKvScan, isConsumerNotFound, type EpServeLedgerRow,
} from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { makeLedgerScannerOverConnection, authorityScannerGrants } from "../src/ledger-scanner.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { openRegistrationFamilyScan } from "../src/registration-family-scan.js";
import { requestManagerRegistrationFamily, requestManagerRegistrationRead, remoteManagerServePrincipal, RegistrationFamilyBusyError, RegistrationFamilyRefusedError } from "@cotal-ai/core";

const evidence = process.env.FAMILY_SCAN_EVIDENCE_DIR;
const dir = mkdtempSync(join(evidence ?? tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
const space = "familyscan", otherSpace = "familyscanother", endpoint = "manager";
const brokerAuth = await createBrokerAuth(space);
const auth = { ...brokerAuth, ...await createSpaceAccountAuth(brokerAuth, space) };
const otherAuth = { ...brokerAuth, ...await createSpaceAccountAuth(brokerAuth, otherSpace) };
writeFileSync(join(dir, "server.conf"), serverConfig(brokerAuth, [auth, otherAuth], {
  host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" },
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
let passed = 0;
const check = (name: string, ok: boolean): void => { assert.ok(ok, name); passed++; console.log(`  ✓ ${name}`); };
const record = (data: object): void => { if (evidence) appendFileSync(join(dir, "measurements.jsonl"), JSON.stringify(data) + "\n", { mode: 0o600 }); };
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await new Promise(resolve => setTimeout(resolve, 50));
  check("owned loopback broker answers", await isReachable(servers));
  for (const a of [auth, otherAuth]) await setupSpaceStreams({ servers, space: a.space, creds: await mintCreds(a, newIdentity(), "provisioner") });
  const open = async (creds: string): Promise<NatsConnection> => {
    const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), reconnect: false });
    connections.push(nc); return nc;
  };
  const provisioner = await open(await mintCreds(auth, newIdentity(), "provisioner"));
  const owner = `u_${"a".repeat(26)}`;
  const scanClient = await openAuthorityClient({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, label: "family-scan-smoke", grants: id => authorityScannerGrants(space, id), log: console.error });
  let failAfterFirstChunk = false;
  let stallNextFamilyScan = false;
  let deadlineScanStarted: (() => void) | undefined;
  let deadlineScanAborted: (() => void) | undefined;
  const scanner = makeLedgerScannerOverConnection(scanClient.nc, space, { afterFirstFetch: async signal => {
    if (!stallNextFamilyScan) return;
    stallNextFamilyScan = false;
    if (!signal) throw new Error("registration scan did not receive an abort signal");
    deadlineScanStarted?.();
    if (!signal.aborted) await once(signal, "abort");
    deadlineScanAborted?.();
  } });
  const host = await open(await mintCreds(auth, newIdentity(), "issuer", { principal: { owner, actor: "host" } }));
  let corruption = "";
  let scanStarted: (() => void) | undefined;
  let blockedReadInstance: string | undefined;
  let blockedReadCount = 0;
  let blockedReadGate: Promise<void> | undefined;
  let blockedReadStarted: (() => void) | undefined;
  const responder = await openRegistrationFamilyScan({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, log: console.error, scanner, authKv: await new Kvm(host).open(epAuthBucket(space)), recordsKv: await new Kvm(provisioner).open(recordsBucket(space)), probeScanStarted: () => scanStarted?.(), probePointRead: async instanceId => {
    if (instanceId === blockedReadInstance && blockedReadGate) {
      blockedReadCount++;
      if (blockedReadCount === 8) blockedReadStarted?.();
      await blockedReadGate;
    }
  }, probeChunks: chunks => {
    if (failAfterFirstChunk) return (function* () {
      yield chunks[0]!;
      throw new Error("probe failed after first chunk");
    })();
    if (chunks.length < 2 || !corruption) return chunks;
    if (corruption === "drop") return chunks.slice(1);
    if (corruption === "duplicate") return [chunks[0]!, chunks[0]!, ...chunks.slice(1)];
    if (corruption === "order") return [chunks[1]!, chunks[0]!, ...chunks.slice(2)];
    if (corruption === "count") return chunks.map((chunk, i) => i === chunks.length - 1 ? { ...chunk, rowCount: -1 } : chunk);
    if (corruption === "truncate") return chunks.map((chunk, i) => i === chunks.length - 1 ? { ...chunk, rows: (chunk.rows as unknown[]).slice(0, -1) } : chunk);
    return chunks.map((chunk, i) => i === 1 ? { ...chunk, scanId: "A".repeat(24) } : chunk);
  } });
  const scanRemote = (nc: NatsConnection, instanceId: string, timeoutMs = 5 * 60_000) => requestManagerRegistrationFamily(nc, space, owner, instanceId, timeoutMs);
  const jsm = await jetstreamManager(provisioner);
  const scannerJsm = await jetstreamManager(scanClient.nc);
  const other = await open(await mintCreds(otherAuth, newIdentity(), "provisioner"));
  await (await new Kvm(other).open(epAuthBucket(otherSpace))).status();
  check("other account's auth bucket genuinely exists", true);
  const execFor = async (instanceId: string) => {
    const nc = await open(await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint, instanceId }, expiresInSeconds: 60,
    }));
    return { nc, kv: await new Kvm(nc).open(epAuthBucket(space)) };
  };
  // Same seedless signer/profile/options as auth service prepare: the remote side keeps its seed.
  const remoteFor = async (instanceId: string) => {
    const identity = newIdentity(), owner = `u_${"a".repeat(26)}`, actor = remoteManagerActors(instanceId).executor;
    const issued = await mintPublicUserJwt(auth, identity.id, "remote-manager", {
      remoteManager: { instanceId, owner, actor }, principal: { owner, actor },
      lifecycleUid: mintLifecycleUid(), expiresInSeconds: 5 * 60,
    });
    const nc = await open(credsFromJwt(issued.jwt, identity));
    return { nc, kv: await new Kvm(nc).open(epAuthBucket(space)) };
  };
  const principal = principalKey(DEV_OWNER, "holder").key;
  const rowFor = (instanceId: string): EpServeLedgerRow => ({
    credentialId: mintLifecycleUid(), credentialKey: "", holderPrincipal: principal, endpoint, lifecycleUid: instanceId,
    sourceChain: ["root"], state: "active", exp: Math.floor(Date.now() / 1000) + 3600,
    generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
  });
  const foreignId = mintLifecycleUid(), foreign = await execFor(foreignId);
  await provisionEndpointGateOpen(foreign.kv, { endpoint, instanceId: foreignId, principal });
  await serveIssuanceGateKv(foreign.kv, space, { endpoint, instanceId: foreignId }).stage(rowFor(foreignId));
  const measure = async (nc: NatsConnection, work: () => EpServeLedgerRow[] | Promise<EpServeLedgerRow[]>) => {
    const request = nc.request.bind(nc); let rpcRequests = 0;
    nc.request = (...args: Parameters<typeof request>) => { rpcRequests++; return request(...args); };
    const before = nc.stats().outMsgs, wall = performance.now(), cpu = process.cpuUsage();
    try {
      const rows = await work(), elapsed = process.cpuUsage(cpu), totalPublishes = nc.stats().outMsgs - before;
      return { rows, rpcRequests, totalPublishes, nonRpcPublishes: totalPublishes - rpcRequests,
        wallMs: performance.now() - wall, cpuMs: (elapsed.user + elapsed.system) / 1000 };
    } finally { nc.request = request; }
  };
  const deniedPublish = async (nc: NatsConnection, subject: string, name: string) => {
    const watch = openPublishDenialWatch(nc, subject, error => error, name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      nc.publish(subject);
      const error = await Promise.race([watch.denied.catch(error => error), new Promise<unknown>(resolve => {
        timer = setTimeout(() => resolve(new Error("broker denial not observed")), 5000);
      })]);
      check(name, error instanceof Error && /permissions violation/i.test(error.message));
    } finally { clearTimeout(timer); watch.release(); }
  };
  const costs: number[] = [], remoteCosts: number[] = [];
  for (const count of [0, 7905, 12753]) {
    const instanceId = mintLifecycleUid(), setup = await execFor(instanceId);
    await provisionEndpointGateOpen(setup.kv, { endpoint, instanceId, principal: remoteManagerServePrincipal(owner, instanceId) });
    const writer = serveIssuanceGateKv(setup.kv, space, { endpoint, instanceId });
    const barrier = endpointRegistrationBarrier(setup.kv, space, { endpoint, instanceId, opId: mintLifecycleUid() });
    const expected = new Set<string>();
    for (let start = 0; start < count; start += 16) await Promise.all(Array.from({ length: Math.min(16, count - start) }, async () => {
      const row = rowFor(instanceId); expected.add(row.credentialId); await writer.stage(row); await barrier.revoke(row);
    }));
    const before = await setup.kv.get(epgateKey(endpoint, instanceId));
    const consumersBefore = (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count;
    const measured = await measure(setup.nc, () => barrier.enumerate()), { rows } = measured;
    record({ count, ...measured, rows: rows.length });
    costs.push(measured.rpcRequests);
    check(`${count}: exact retained family including revoked rows`, rows.length === count && new Set(rows.map(row => row.credentialId)).size === count && rows.every(row => expected.has(row.credentialId) && row.state === "revoked" && row.endpoint === endpoint && row.lifecycleUid === instanceId));
    const after = await setup.kv.get(epgateKey(endpoint, instanceId));
    check(`${count}: enumeration leaves the gate unchanged`, before?.revision === after?.revision && Buffer.from(before!.value).equals(Buffer.from(after!.value)));
    check(`${count}: scan reclaims its native consumer`, (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === consumersBefore);
    const remote = await remoteFor(instanceId);
    const remoteMeasured = await measure(remote.nc, () => scanRemote(remote.nc, instanceId));
    const remoteRows = remoteMeasured.rows;
    remoteCosts.push(remoteMeasured.rpcRequests); record({ count, profile: "remote-manager-executor", ...remoteMeasured, rows: remoteRows.length });
    check(`${count}: host-signed remote executor sees the same exact family`, remoteRows.length === count && new Set(remoteRows.map(value => value.credentialId)).size === count && remoteRows.every(value => expected.has(value.credentialId) && value.state === "revoked"));
    if (count === 7905) {
      const peerId = mintLifecycleUid(), peer = await remoteFor(peerId);
      await provisionEndpointGateOpen((await execFor(peerId)).kv, { endpoint, instanceId: peerId, principal: remoteManagerServePrincipal(owner, peerId) });
      const started = new Promise<void>((resolve) => { scanStarted = resolve; });
      const scanning = scanRemote(remote.nc, instanceId);
      await started;
      scanStarted = undefined;
      await assert.rejects(scanRemote(remote.nc, instanceId), RegistrationFamilyBusyError);
      check("overlapping same-instance scan is busy", true);
      const peerRead = await requestManagerRegistrationRead(peer.nc, space, owner, peerId, { kind: "read", key: epgateKey(endpoint, peerId) });
      const ownRead = await requestManagerRegistrationRead(remote.nc, space, owner, instanceId, { kind: "read", key: epgateKey(endpoint, instanceId) });
      check("own point read completes while its family scan runs", ownRead !== null && typeof ownRead !== "number");
      check("point read completes while another family scan runs", peerRead !== null && typeof peerRead !== "number");
      await scanning;
      let releasePointReads!: () => void;
      let markPointReadsStarted!: () => void;
      const pointReadGate = new Promise<void>(resolve => { releasePointReads = resolve; });
      const pointReadsStarted = new Promise<void>(resolve => { markPointReadsStarted = resolve; });
      blockedReadInstance = instanceId; blockedReadCount = 0; blockedReadGate = pointReadGate; blockedReadStarted = markPointReadsStarted;
      const heldReads = Array.from({ length: 8 }, () => requestManagerRegistrationRead(remote.nc, space, owner, instanceId, { kind: "read", key: epgateKey(endpoint, instanceId) }));
      await pointReadsStarted;
      check("eight point reads for one instance are admitted concurrently", blockedReadCount === 8);
      await assert.rejects(requestManagerRegistrationRead(remote.nc, space, owner, instanceId, { kind: "read", key: epgateKey(endpoint, instanceId) }), RegistrationFamilyBusyError);
      check("the ninth concurrent point read for one instance is busy", true);
      const peerReadAtCap = await requestManagerRegistrationRead(peer.nc, space, owner, peerId, { kind: "read", key: epgateKey(endpoint, peerId) });
      check("another instance point read succeeds while the first instance is at its cap", peerReadAtCap !== null && typeof peerReadAtCap !== "number");
      releasePointReads();
      const completedReads = await Promise.all(heldReads);
      blockedReadInstance = undefined; blockedReadGate = undefined; blockedReadStarted = undefined;
      check("all admitted point reads complete after release", completedReads.length === 8 && completedReads.every(value => value !== null && typeof value !== "number"));
      let markDeadlineScanStarted!: () => void;
      let markDeadlineScanAborted!: () => void;
      const deadlineStarted = new Promise<void>(resolve => { markDeadlineScanStarted = resolve; });
      const deadlineAborted = new Promise<void>(resolve => { markDeadlineScanAborted = resolve; });
      deadlineScanStarted = markDeadlineScanStarted; deadlineScanAborted = markDeadlineScanAborted; stallNextFamilyScan = true;
      const timedOutScan = scanRemote(remote.nc, instanceId, 150);
      await deadlineStarted;
      deadlineScanStarted = undefined;
      await assert.rejects(timedOutScan, /registration family scan timed out/);
      await deadlineAborted;
      deadlineScanAborted = undefined;
      const stream = `KV_${epAuthBucket(space)}`;
      let consumerAbsent = false;
      for (let attempt = 0; attempt < 100 && !consumerAbsent; attempt++) {
        try { await scannerJsm.consumers.info(stream, "cotal-ledger-scan"); }
        catch (error) { if (!isConsumerNotFound(error)) throw error; consumerAbsent = true; }
        if (!consumerAbsent) await new Promise(resolve => setTimeout(resolve, 10));
      }
      check("deadline abort deletes the real literal consumer", consumerAbsent && (await jsm.streams.info(stream)).state.consumer_count === consumersBefore);
      const freshScan = await scanRemote(remote.nc, instanceId);
      check("deadline abort releases the process-wide scanner lock", freshScan.length === count);
      for (const [mode, message] of [["drop", /invalid registration family chunk/], ["duplicate", /invalid registration family chunk/], ["order", /invalid registration family chunk/], ["count", /incomplete registration family chunks/], ["truncate", /incomplete registration family chunks/], ["scanId", /inconsistent registration family chunks/]] as const) {
        corruption = mode;
        let failure: unknown;
        try { await scanRemote(remote.nc, instanceId); } catch (error) { failure = error; } finally { corruption = ""; }
        check(`${mode} family chunk fails closed`, failure instanceof Error && message.test(failure.message));
      }
      failAfterFirstChunk = true;
      let failedScan: unknown;
      try { await scanRemote(remote.nc, instanceId); } catch (error) { failedScan = error; } finally { failAfterFirstChunk = false; }
      check("failure after first family chunk returns a plain scan failure", failedScan instanceof Error &&
        !(failedScan instanceof RegistrationFamilyRefusedError) && /registration family scan failed/.test(failedScan.message));
    }
    check(`${count}: remote executor deletes its scan consumer`, (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === consumersBefore);
    let remoteDenied: unknown;
    try { await (await new Kvm(remote.nc).open(epAuthBucket(otherSpace))).status(); } catch (error) { remoteDenied = error; }
    check(`${count}: remote executor cannot read the other account`, remoteDenied instanceof Error && /Permissions Violation/.test(remoteDenied.message));
    await deniedPublish(setup.nc, `$JS.FC.KV_${recordsBucket(space)}.probe`, `${count}: CLI flow control cannot reach another stream`);
    await deniedPublish(setup.nc, `$JS.FC.KV_${epAuthBucket(otherSpace)}.probe`, `${count}: CLI flow control cannot reach another account`);
    let foreignWrite: unknown;
    try { await provisionEndpointGateOpen(setup.kv, { endpoint, instanceId: foreignId, principal }); } catch (error) { foreignWrite = error; }
    check(`${count}: CLI data writes stay instance-key-pinned`, foreignWrite instanceof Error && /Permissions Violation/.test(foreignWrite.message));
    let denied: unknown;
    try { await (await new Kvm(setup.nc).open(epAuthBucket(otherSpace))).status(); } catch (error) { denied = error; }
    check(`${count}: native broker refuses another account's stream`, denied instanceof Error && /Permissions Violation/.test(denied.message));
  }
  check("large retained families do not add per-row API requests", costs[2]! <= costs[1]! + 2);

  check("remote executor also avoids per-row API requests", remoteCosts[2]! <= remoteCosts[1]! + 2);

  const instanceId = mintLifecycleUid(), active = await remoteFor(instanceId);
  await provisionEndpointGateOpen((await execFor(instanceId)).kv, { endpoint, instanceId, principal: remoteManagerServePrincipal(owner, instanceId) });
  const read = async (key: string) => {
    const result = await requestManagerRegistrationRead(active.nc, space, owner, instanceId, { kind: "read", key });
    if (typeof result === "number") throw new Error("unexpected read result");
    return result;
  };
  const writer = serveIssuanceGateKv(active.kv, space, { endpoint, instanceId, read });
  const row = rowFor(instanceId); await writer.stage(row);
  const barrier = endpointRegistrationBarrier(active.kv, space, { endpoint, instanceId, opId: mintLifecycleUid(), read, enumerateFamily: () => scanRemote(active.nc, instanceId) });
  const observed = await barrier.observe(); assert.ok(observed);
  const frozen = await barrier.freeze(observed.revision); assert.notEqual(frozen, null);
  check("freeze still defeats an earlier mint commit", !await writer.commit(observed.revision));
  check("frozen family retains active credential evidence", (await barrier.enumerate()).some(value => value.credentialId === row.credentialId && value.state === "active"));
  await Promise.all([barrier.enumerate(), barrier.revoke(row)]);
  check("fresh scan observes concurrent revoke after it settles", (await barrier.enumerate()).every(value => value.state === "revoked"));
  check("missing evictor still refuses verification", (await barrier.evict([principal])).every(value => value === false));
  check("stale freeze token still loses reopen", !await barrier.reopen(frozen! - 1, { generation: 1, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0 }));

  // A real consumer and bind count; only the clean premature end is a detector seam, as in kv-scan.smoke.
  const bucket = (await execFor(instanceId)).kv as Bucket, realGet = bucket.js.consumers.getPushConsumer.bind(bucket.js.consumers);
  const victim = Object.create(bucket) as KV;
  Object.defineProperty(victim, "js", { value: { ...bucket.js, consumers: { ...bucket.js.consumers,
    getPushConsumer: async (...args: Parameters<typeof realGet>): Promise<PushConsumer> => {
      const oc = await realGet(...args);
      return Object.assign(Object.create(oc), { consume: async () => Object.assign((async function* () {})(), { close: async () => {} }) });
    },
  } } });
  const beforeCut = (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count;
  let cut: unknown;
  try { await endpointRegistrationBarrier(victim, space, { endpoint, instanceId, opId: mintLifecycleUid() }).enumerate(); } catch (error) { cut = error; }
  check("incomplete family never becomes a complete empty answer", cut instanceof IncompleteKvScan && cut.expected > 0);
  check("incomplete family scan cleans up its consumer", (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === beforeCut);
  const malformedId = mintLifecycleUid();
  await active.kv.create(epcredRowKey(endpoint, instanceId, malformedId), new TextEncoder().encode("{}"));
  let malformed: unknown;
  try { await barrier.enumerate(); } catch (error) { malformed = error; }
  check("malformed family evidence still refuses", malformed instanceof Error);
  check("parsing refusal leaves no scan consumer", (await jsm.streams.info(`KV_${epAuthBucket(space)}`)).state.consumer_count === beforeCut);
  await responder.close();
  await scanClient.close();
} finally {
  for (const nc of connections) await nc.close().catch(() => {});
  const exited = broker.exitCode === null && broker.signalCode === null ? once(broker, "exit") : Promise.resolve();
  broker.kill("SIGKILL"); await exited; releaseBroker();
  if (evidence) writeFileSync(join(dir, "OUTCOME.json"), JSON.stringify({ passed, port, brokerExited: true }) + "\n", { mode: 0o600 });
  else rmSync(dir, { recursive: true, force: true });
}
assert.equal(passed, 59, "all family scan cells ran");
console.log(`ENDPOINT FAMILY SCAN: ${passed} passed`);
