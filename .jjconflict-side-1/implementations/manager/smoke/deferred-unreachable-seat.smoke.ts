/**
 * Deferred unreachable seat over a real broker: an unadopted static slot whose seat this manager
 * cannot reap waits out its credential before the terminal. Cells: an unexpired credential defers,
 * an expired one terminalizes, a deferred seat terminalizes on the renewal tick after expiry, an
 * operator attest-gone drives the terminal, and a plain stop on a deferred seat returns the remedy.
 *
 * Run: pnpm smoke:deferred-unreachable-seat   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  createSpaceAuth,
  mintCreds,
  newIdentity,
  principalKey,
  setupSpaceStreams,
  standaloneConnectOpts,
  DEV_OWNER,
  mintLifecycleUid,
  recordsBucket,
  epAuthBucket,
  EpEnvelopeError,
  registry,
  type Connector,
  type AgentHandle,
  type EpCommandDef,
  type EvictionResult,
  type Presence,
  type StaticManagedSlotRow,
  type LifecycleStateTransport,
} from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";
import type { ManagerStatus, ManagerStaticReconciliationFailure } from "../src/manager-service-contract.js";
import {
  staticLifecycleTransport,
  readStaticSlot,
  activateStaticLifecycle,
  casStaticSlot,
  recordSlotCredential,
  appendStaticCredentialRow,
} from "../src/static-lifecycle.js";
import { bootBroker } from "./_boot-broker.js";
import { requestDeliveryAdminZeroMemberships } from "./_fake-delivery-admin.js";

let passed = 0;
let failed = 0;
/** Intent, not a measurement: one per check below. A shortfall means a cell stopped running. */
const EXPECTED_CHECKS = 23;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra) ?? ""}`}`);
  if (cond) passed++;
  else failed++;
}

const space = `deferred-seat-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-deferred-seat-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
type Executor = <T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>) => Promise<T>;
type Seams = {
  auth: unknown;
  runtime: unknown;
  ep: Record<string, unknown>;
  managerInstanceId: string;
  agents: Map<string, { id: string; name: string; lifecycleUid: string }>;
  staticReconcileRetryDelaysMs: readonly number[];
  staticLifecycleEvict?: (principal: string) => Promise<EvictionResult>;
  reconcileStaticLifecycles: () => Promise<void>;
  recheckDeferredSeats: () => Promise<void>;
  renewDaemonCreds: () => Promise<void>;
  opStop: (args: Record<string, unknown>, caller: string, admin: boolean) => Promise<{ ok: boolean; error?: string }>;
  managerStatusData: () => ManagerStatus;
  driveDeferredRecheck: () => Promise<void>;
  readStaticReconcileSlot: (alias: string) => Promise<StaticManagedSlotRow | undefined>;
  credentialDeferral: (row: StaticManagedSlotRow) => Promise<{ deferUntil?: string; remedy?: string; lastError?: string } | undefined>;
  deferStaticReconcileItem: (key: string, row: StaticManagedSlotRow, deferral: { deferUntil?: string; remedy?: string; lastError?: string }) => void;
  managerServiceDefs: () => EpCommandDef[];
  withLifecycleExecutor: Executor;
  reconcilingAliases: Set<string>;
  staticReleasePending: Set<string>;
  staticReconcileItems: Map<string, ManagerStaticReconciliationFailure>;
  goalWriter?: { ctx: { kv: KV } };
  abortPreservation: (attemptId: string) => void;
  preservationAttemptId?: string;
  credRenewTimer?: NodeJS.Timeout;
};
const M = mgr as unknown as Seams;
M.auth = auth;
M.managerInstanceId = "deferred-smoke-instance";
M.staticReconcileRetryDelaysMs = [60_000];
// A runtime with no reserve/reap: it cannot prove a seat gone by reference.
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
M.runtime = {
  kind: "fake",
  spawn: (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, waitForExit: async () => {}, interrupt: () => {}, attach: () => fakeSession }),
};
M.ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: () => Promise.resolve(),
  requestDeliveryAdmin: requestDeliveryAdminZeroMemberships,
  getRoster: (): Presence[] => [...M.agents.values()].map((agent): Presence => ({ card: { id: principalKey(DEV_OWNER, agent.id).key, name: agent.name, role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: agent.lifecycleUid, ts: 0 })),
};
M.staticLifecycleEvict = async (principal) => ({ principal, kicked: 0, remaining: 0, scanComplete: true, verifiedGone: true });
const quiet: Connector = { kind: "connector", name: "smoke-deferred", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(quiet);

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Plant an unadopted active slot with one ledgered credential at `exp`. */
async function plant(alias: string, exp: number): Promise<{ actor: string; uid: string }> {
  const actor = newIdentity().id;
  const uid = mintLifecycleUid();
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor, lifecycleUid: uid, alias } });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
    await activateStaticLifecycle(t, { owner: DEV_OWNER, alias, actor, lifecycleUid: uid, managerInstance: "smoke", ownerInstanceId: M.managerInstanceId });
    const credentialId = `cred-${alias}`;
    await recordSlotCredential(t, DEV_OWNER, alias, uid, credentialId);
    await appendStaticCredentialRow(t, { lifecycleUid: uid, credentialId, holderPrincipal: principalKey(DEV_OWNER, actor).key, exp });
    const slot = await readStaticSlot(t, DEV_OWNER, alias);
    await casStaticSlot(t, { ...slot!.row, phase: "active" }, slot!.revision);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
  return { actor, uid };
}

async function readSlot(alias: string): Promise<StaticManagedSlotRow | undefined> {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(nc).open(recordsBucket(space));
    return (await readStaticSlot(staticLifecycleTransport(kv, kv), DEV_OWNER, alias))?.row;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

const item = (alias: string): ManagerStaticReconciliationFailure | undefined =>
  M.managerStatusData().staticReconciliation.failures.find((f) => f.alias === alias);

const operator = { owner: DEV_OWNER, actor: "operator_a", uid: mintLifecycleUid() };

type ServeReply = { ok: true; data: unknown } | { ok: false; message: string };
/** Invoke one served command as the operator; the reply data or the envelope error text. */
async function serve(command: string, args: Record<string, unknown>): Promise<ServeReply> {
  const def = M.managerServiceDefs().find((d) => d.command === command);
  if (def === undefined) return { ok: false, message: `${command} is not registered` };
  try {
    return { ok: true, data: await def.handler({ subject: { caller: operator, command }, request: { args } } as unknown as Parameters<EpCommandDef["handler"]>[0]) };
  } catch (e) {
    return { ok: false, message: e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : String(e) };
  }
}
const attestGone = (args: Record<string, unknown>): Promise<ServeReply> => serve("attest-gone", args);
/** Capture manager log lines for an assertion about an operator attestation. */
async function captureErrors(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); original(...args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}



let inspectNc: NatsConnection | undefined;
try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  // The served inspect miss path reads durable slots through the goal-writer's records KV.
  inspectNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }), maxReconnectAttempts: 0 });
  M.goalWriter = { ctx: { kv: await new Kvm(inspectNc).open(recordsBucket(space)) } };

  // Plant every coordinate before the one boot sweep, so each cell grades the same sweep.
  await plant("unexpired", nowSec() + 3600);
  await plant("expired", nowSec() - 120);
  // deferUntil = exp + 60, so this one lapses a few seconds into the run.
  const tickExp = nowSec() - 54;
  await plant("tick", tickExp);
  await plant("worker_2", nowSec() + 3600);
  await plant("attest", nowSec() + 3600);
  await plant("plain", nowSec() + 3600);
  await plant("busy", nowSec() + 3600);
  const unreadable = await plant("unreadable", nowSec() + 3600);
  // The expiry read fails for this one row only: its ledger cannot be read.
  const executor = M.withLifecycleExecutor.bind(mgr);
  const probed: Executor = (pin, fn) => pin.lifecycleUid === unreadable.uid
    ? Promise.reject(new Error("smoke: the auth store is unreadable"))
    : executor(pin, fn);
  // Record every alias the fence held while an expiry read was in flight.
  const fencedDuringRead = new Set<string>();
  M.withLifecycleExecutor = (pin, fn) => {
    for (const alias of M.reconcilingAliases) fencedDuringRead.add(alias);
    return probed(pin, fn);
  };
  await M.reconcileStaticLifecycles();
  M.withLifecycleExecutor = probed;

  // ── Unexpired credential defers ──
  const deferred = item("unexpired");
  check("unexpired: the boot sweep defers the slot with deferUntil and leaves it active",
    deferred?.disposition === "deferred" && typeof deferred.deferUntil === "string" && (await readSlot("unexpired"))?.phase === "active",
    { deferred, slot: await readSlot("unexpired") });
  check("unexpired: status counts it in staticReconciliation.deferredSeats",
    M.managerStatusData().staticReconciliation.deferredSeats === 7, M.managerStatusData().staticReconciliation);
  check("fence: every plannable alias is fenced before the first expiry read, and a deferred alias leaves it",
    ["unexpired", "expired", "tick", "attest", "plain", "busy", "unreadable", "worker_2"].every((a) => fencedDuringRead.has(a)) && !M.reconcilingAliases.has("unexpired"),
    { fenced: [...fencedDuringRead], after: [...M.reconcilingAliases] });

  // ── Unreadable ledger: deferred, with a remedy that says it never lapses ──
  const bad = item("unreadable");
  check("unreadable: deferred with no deferUntil, the read error, and an executable --name remedy",
    bad?.disposition === "deferred" && bad.deferUntil === undefined && /unreadable/.test(bad.lastError ?? "") && /will not terminalize on its own/.test(bad.remedy ?? "") && /cotal stop --name <alias> --attest-gone/.test(bad.remedy ?? ""), bad);

  // ── Expired credential terminalizes ──
  check("expired: the boot sweep terminalizes the slot through the existing path",
    (await readSlot("expired"))?.phase === "retired" && item("expired") === undefined, { slot: await readSlot("expired"), item: item("expired") });

  // ── Deferred, then terminalized on the renewal tick after expiry ──
  check("tick: deferred while its credential proof holds", item("tick")?.disposition === "deferred" && item("tick")?.deferUntil === new Date((tickExp + 60) * 1000).toISOString(), item("tick"));
  await M.recheckDeferredSeats();
  check("tick: a renewal tick before deferUntil keeps it deferred and active",
    Date.now() < (tickExp + 60) * 1000 ? item("tick")?.disposition === "deferred" && (await readSlot("tick"))?.phase === "active" : false,
    { item: item("tick"), now: Date.now(), until: (tickExp + 60) * 1000 });
  // The same whole second as deferUntil: credentialDeferral still defers there, so the tick must not pick it up.
  const sameSecond = (tickExp + 60) * 1000 - Date.now() + 200;
  if (sameSecond > 0) await sleep(sameSecond);
  const reads: string[] = [];
  M.withLifecycleExecutor = (pin, fn) => { reads.push(pin.alias); return probed(pin, fn); };
  await M.recheckDeferredSeats();
  M.withLifecycleExecutor = probed;
  check("tick: a tick in the same second as deferUntil does not re-read or re-defer it",
    Math.floor(Date.now() / 1000) === tickExp + 60 ? !reads.includes("tick") && item("tick")?.disposition === "deferred" : false,
    { reads, now: Date.now(), until: (tickExp + 60) * 1000 });
  await sleep(1500);
  // The tick fires from the timer a prepare-then-abort cycle re-armed, through the shared tick body.
  M.renewDaemonCreds = async () => {};
  clearInterval(M.credRenewTimer);
  M.credRenewTimer = undefined;
  M.preservationAttemptId = "smoke-attempt";
  const realSetInterval = globalThis.setInterval;
  let rearmedTick: (() => void) | undefined;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    rearmedTick = fn;
    return realSetInterval(() => {}, ms);
  }) as typeof setInterval;
  try { M.abortPreservation("smoke-attempt"); } finally { globalThis.setInterval = realSetInterval; }
  rearmedTick?.();
  const tickRetired = await (async () => {
    for (let i = 0; i < 100; i++) {
      if ((await readSlot("tick"))?.phase === "retired") return true;
      await sleep(100);
    }
    return false;
  })();
  clearInterval(M.credRenewTimer);
  check("tick: the renewal tick re-armed by abortPreservation terminalizes it after deferUntil", tickRetired && item("tick") === undefined,
    { slot: await readSlot("tick"), item: item("tick") });
  check("tick: the unexpired seats stay deferred across the same tick", item("unexpired")?.disposition === "deferred" && (await readSlot("unexpired"))?.phase === "active", item("unexpired"));

  // ── A plain stop on a deferred seat returns the remedy, through the served door ──
  const plain = await serve("inspect", { name: "plain" });
  check("plain stop: target resolution returns the --name and pinned --on remedy, slot unchanged",
    !plain.ok && /deferred unreachable seat/.test(plain.message) && plain.message.includes(`cotal stop --name plain --on ${M.managerInstanceId} --attest-gone`) && (await readSlot("plain"))?.phase === "active" && item("plain")?.disposition === "deferred",
    { plain, slot: await readSlot("plain") });

  // ── A spawn of a deferred alias is refused at the alias check ──
  writeFileSync(join(workspaceRoot, ".cotal", "agents", "plain.md"), "---\nname: plain\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n");
  const respawn = await mgr.startAgent({ name: "plain", agent: "smoke-deferred", events: false });
  check("spawn: a deferred alias is refused at the alias check with the deferred-seat refusal, the slot unchanged",
    !respawn.ok && /deferred unreachable seat/.test(respawn.error ?? "") && (await readSlot("plain"))?.phase === "active" && item("plain")?.disposition === "deferred",
    { respawn, slot: await readSlot("plain") });
  writeFileSync(join(workspaceRoot, ".cotal", "agents", "worker.md"), "---\nname: worker\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n");
  const worker = await mgr.startAgent({ name: "worker", agent: "smoke-deferred", events: false });
  const autoNumber = await mgr.startAgent({ name: "worker", agent: "smoke-deferred", events: false });
  check("spawn: auto-numbered deferred alias returns its deferred-seat refusal before slot admission",
    worker.ok && (worker.data as { name?: string }).name === "worker" && !autoNumber.ok && autoNumber.error?.startsWith(`\"worker_2\" is a deferred unreachable seat on manager instance ${M.managerInstanceId}`) === true && (await readSlot("worker_2"))?.phase === "active" && item("worker_2")?.disposition === "deferred",
    { autoNumber, slot: await readSlot("worker_2"), item: item("worker_2") });
  check("plain stop: a blank attest-gone reason fails the input schema", (() => {
    const def = M.managerServiceDefs().find((d) => d.command === "attest-gone");
    return def !== undefined && def.contract.input.validate({ name: "plain", attestGone: "   " }) === false;
  })());
  const forged = "gone\nstatic reconcile attested-gone alias=other";
  const schemaRefusesBreak = M.managerServiceDefs().find((d) => d.command === "attest-gone")?.contract.input.validate({ name: "plain", attestGone: forged }) === false;
  const runtimeRefusesBreak = await M.opStop({ name: "plain", attestGone: forged }, principalKey(operator.owner, operator.actor).key, true);
  check("attest-gone: a reason with a line break fails the input schema and the runtime check, the slot unchanged",
    schemaRefusesBreak && !runtimeRefusesBreak.ok && /one line/.test(runtimeRefusesBreak.error ?? "") && (await readSlot("plain"))?.phase === "active" && item("plain")?.attestedGone === undefined,
    { schemaRefusesBreak, runtimeRefusesBreak });

  // ── attest-gone refused before a terminal starts records no attestation ──
  const busyItem = item("busy");
  M.staticReleasePending.add(JSON.stringify(["busy", busyItem?.lifecycleUid]));
  const busy = await attestGone({ name: "busy", attestGone: "confirmed gone" });
  M.staticReleasePending.clear();
  check("attest-gone: when no terminal starts, the reply says so and no attestation is recorded",
    !busy.ok && /did not start/.test(busy.message) && item("busy")?.attestedGone === undefined && (await readSlot("busy"))?.phase === "active", { busy, item: item("busy") });

  // ── attest-gone drives the terminal; a sweep during its flight joins it ──
  type Retire = (a: { name: string }, ...rest: unknown[]) => Promise<void>;
  const R = mgr as unknown as { driveStaticRetirement: Retire };
  const retire = R.driveStaticRetirement.bind(mgr);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  let entered: () => void = () => {};
  const reached = new Promise<void>((r) => { entered = r; });
  R.driveStaticRetirement = async (a, ...rest) => {
    if (a.name === "attest") { entered(); await held; }
    return retire(a, ...rest);
  };
  let reply: ServeReply | undefined;
  let joinedState: { disposition?: string; deferUntil?: string; fenced: boolean } | undefined;
  const lines = await captureErrors(async () => {
    const pending = attestGone({ name: "attest", attestGone: "host rebooted, processes confirmed gone" });
    await reached;
    const sweep = M.reconcileStaticLifecycles();
    // Give the sweep time to plan "attest" while its flight is held.
    await sleep(1500);
    const during = item("attest");
    joinedState = { disposition: during?.disposition, deferUntil: during?.deferUntil, fenced: M.reconcilingAliases.has("attest") };
    release();
    await sweep;
    reply = await pending;
  });
  R.driveStaticRetirement = retire;
  check("sweep: a sweep during an attest-gone flight joins it and leaves the item and fence alone (not reset to deferred)",
    joinedState?.disposition === "retrying" && joinedState.deferUntil === undefined && joinedState.fenced === true, joinedState);
  check("attest-gone: the served command terminalizes the deferred slot", reply?.ok === true && (await readSlot("attest"))?.phase === "retired", { reply, slot: await readSlot("attest") });
  check("attest-gone: the log names alias, uid, caller and reason",
    lines.some((l) => /static reconcile attested-gone alias=attest uid=\S+ by=\S+operator_a\S*: host rebooted, processes confirmed gone/.test(l)), lines.filter((l) => l.includes("attest")));
  check("attest-gone: status records the attestation on the item", item("attest")?.attestedGone === "host rebooted, processes confirmed gone" && item("attest")?.disposition === "recovered", item("attest"));
  // A terminal that starts during either deferred tick await must keep ownership of the item.
  const raceItem = [...M.staticReconcileItems.values()].find((candidate) => candidate.alias === "unexpired");
  if (raceItem !== undefined) {
    raceItem.deferUntil = undefined;
    const originalSlotReader = M.readStaticReconcileSlot;
    const slotReader = originalSlotReader.bind(M);
    const originalCredentialReaderForRead = M.credentialDeferral;
    const credentialReaderForRead = originalCredentialReaderForRead.bind(M);
    let credentialReadsForReadRace = 0;
    M.credentialDeferral = async (row) => {
      if (row.alias === "unexpired") credentialReadsForReadRace++;
      return await credentialReaderForRead(row);
    };
    let releaseRead: () => void = () => {};
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reachedRead: () => void = () => {};
    const readReached = new Promise<void>((resolve) => { reachedRead = resolve; });
    const priorReadError = raceItem.lastError;
    M.readStaticReconcileSlot = async (alias) => {
      if (alias === "unexpired") reachedRead();
      const row = await slotReader(alias);
      if (alias === "unexpired") await heldRead;
      return row;
    };
    try {
      const readRace = M.driveDeferredRecheck();
      await readReached;
      raceItem.disposition = "retrying";
      releaseRead();
      await readRace;
    } finally {
      releaseRead();
      M.readStaticReconcileSlot = originalSlotReader;
      M.credentialDeferral = originalCredentialReaderForRead;
    }
    const readRed = raceItem.disposition === "retrying" && raceItem.lastError === priorReadError && credentialReadsForReadRace === 0;
    check("deferred tick does not overwrite a terminal started during the durable read", readRed, { raceItem, priorReadError, credentialReadsForReadRace });

    raceItem.disposition = "deferred";
    const originalCredentialReader = M.credentialDeferral;
    const credentialReader = originalCredentialReader.bind(M);
    let releaseCredential: () => void = () => {};
    const heldCredential = new Promise<void>((resolve) => { releaseCredential = resolve; });
    let reachedCredential: () => void = () => {};
    const credentialReached = new Promise<void>((resolve) => { reachedCredential = resolve; });
    const priorCredentialError = raceItem.lastError;
    M.credentialDeferral = async (row) => {
      if (row.alias === "unexpired") reachedCredential();
      const result = await credentialReader(row);
      if (row.alias === "unexpired") await heldCredential;
      return result;
    };
    try {
      const credentialRace = M.driveDeferredRecheck();
      await credentialReached;
      raceItem.disposition = "retrying";
      releaseCredential();
      await credentialRace;
    } finally {
      releaseCredential();
      M.credentialDeferral = originalCredentialReader;
    }
    check("deferred tick does not overwrite a terminal started during credential proof",
      raceItem.disposition === "retrying" && raceItem.lastError === priorCredentialError, { raceItem, priorCredentialError });
  }

  // ── A custodial runtime never defers a credentialed no-reference row ──
  M.runtime = {
    kind: "pty",
    reserve: () => ({ kind: "pty", id: randomUUID().replaceAll("-", "") }),
    spawn: (name: string): AgentHandle => ({ name, kind: "pty", status: () => "running", stop: () => {}, waitForExit: async () => {}, interrupt: () => {}, attach: () => fakeSession }),
    reap: async () => ({ outcome: "retained", reason: "unprovable", detail: "smoke" }),
  };
  await plant("custodial", nowSec() + 3600);
  await M.reconcileStaticLifecycles();
  const cust = item("custodial");
  check("custodial: an unexpired credentialed no-reference row is refused no-reference, never deferred",
    cust?.disposition === "refused" && cust.retainedReason === "no-reference" && cust.deferUntil === undefined, cust);
} finally {
  await mgr.stop().catch(() => {});
  await inspectNc?.drain().catch(() => inspectNc?.close());
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

const total = passed + failed;
if (total !== EXPECTED_CHECKS) {
  console.log(`DEFERRED UNREACHABLE SEAT SMOKE FAILED (ran ${total} of ${EXPECTED_CHECKS} declared checks)`);
  failed++;
}
console.log(`${failed === 0 ? "DEFERRED UNREACHABLE SEAT SMOKE OK ✅" : "DEFERRED UNREACHABLE SEAT SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed, cells: EXPECTED_CHECKS });
process.exit(failed === 0 ? 0 : 1);
