/**
 * The manager stands fail-closed on seat custody (seat-custody-retention § T3): a fake custodial
 * runtime scripts each reap outcome over a real broker; the escalation cell runs the real pty runtime.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth,
  registry,
  mintCreds,
  newIdentity,
  principalKey,
  setupSpaceStreams,
  standaloneConnectOpts,
  DEV_OWNER,
  mintLifecycleUid,
  recordsBucket,
  RECORD_KINDS,
  recordSpecKey,
  epAuthBucket,
  credRowKey,
  parseLedgerRow,
  staticSlotKey,
  openAclRegistry,
  readAcl,
  dmStream,
  dmDurable,
  EpEnvelopeError,
  type Connector,
  type AgentHandle,
  type Presence,
  type CredentialLedgerRow,
  type StaticManagedSlotRow,
  type EvictionResult,
  type LifecycleStateTransport,
  type RuntimeReference,
} from "@cotal-ai/core";
import { readRecord, recordPath } from "@cotal-ai/seat";
import { agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";
import { Manager, type FreeSlotCause } from "../src/manager.js";
import type { ManagerStatus, ManagerStaticReconciliationFailure } from "../src/manager-service-contract.js";
import type { CustodialRuntime, RuntimeReapEvidence } from "../src/runtime/index.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import { staticLifecycleTransport, readStaticSlot, activateStaticLifecycle, casStaticSlot, writeStaticSlotIntent } from "../src/static-lifecycle.js";
import { setCustodianTestSeam } from "../../../packages/seat/dist/launcher.js";
import { bootBroker } from "./_boot-broker.js";
import { killOwned, owned, type Owned } from "./_owned-kill.js";
import { requestDeliveryAdminZeroMemberships } from "./_fake-delivery-admin.js";

let failures = 0;
let ran = 0;
/** Intent, not a measurement: one per cell assertion below. A shortfall means a cell stopped running. */
const EXPECTED_CHECKS = 24;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${JSON.stringify(extra) ?? ""}`}`);
  ran++;
  if (!cond) failures++;
}
async function until(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

// The escalation cell runs the production custodial runtime; give it a root of its own.
const seatRoot = makeSeatRoot("seats-");
process.env.COTAL_SEAT_ROOT = seatRoot;
const space = `custody-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-custody-ws-"));
const ALIASES = ["retainer", "membersok", "membersmax", "predkept", "fatalres", "failrestart", "othref", "lateref", "membersweep", "clearme", "laterfail", "retryret", "retrymove", "escalate", "rekick", "unres", "unresfail"];
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const alias of ALIASES)
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${alias}.md`), `---\nname: ${alias}\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`);

// ── The fake custodial runtime: every reap outcome is scripted per reference id ──
const UNPROVABLE: RuntimeReapEvidence = { outcome: "retained", reason: "unprovable", detail: "fake: no contained proof" };
const MEMBERS: RuntimeReapEvidence = { outcome: "retained", reason: "members-remain", detail: "fake: the group still holds members" };
/** Outcomes per reference id, consumed in order; the last one sticks. */
const plans = new Map<string, RuntimeReapEvidence[]>();
let unknownPlan: RuntimeReapEvidence | undefined; // a reference with no plan reaps `reaped` unless set
const reaps: string[] = [];
let spawnCalls = 0;
let failNextSpawn = false;
let spawnAs: RuntimeReference | undefined;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeHandle = (name: string, reference: RuntimeReference | undefined): AgentHandle => {
  let running = true;
  return { name, kind: "pty", reference, status: () => running ? "running" : "exited", stop: () => { running = false; }, waitForExit: async () => { running = false; }, interrupt: () => {}, attach: () => fakeSession };
};
const fakeRuntime: CustodialRuntime = {
  kind: "pty",
  reserve: () => ({ kind: "pty", id: randomUUID().replaceAll("-", "") }),
  spawn: (name, _spec, _cwd, reference) => {
    spawnCalls++;
    if (failNextSpawn) {
      failNextSpawn = false;
      throw new Error("smoke: injected replacement spawn failure");
    }
    const ref = spawnAs ?? reference;
    spawnAs = undefined;
    return fakeHandle(name, ref);
  },
  reap: async (ref) => {
    reaps.push(ref.id);
    const plan = plans.get(ref.id);
    if (plan === undefined || plan.length === 0) return unknownPlan ?? { outcome: "reaped", detail: `fake seat ${ref.id} gone` };
    return plan.length > 1 ? plan.shift()! : plan[0]!;
  },
};

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
type Managed = { id: string; name: string; lifecycleUid: string; handle: AgentHandle; secretPaths?: { creds?: string } };
type Executor = <T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>) => Promise<T>;
// The smoke drives private manager seams, as static-lifecycle.smoke.ts does.
const M = mgr as unknown as {
  auth: unknown;
  runtime: unknown;
  ep: Record<string, unknown>;
  managerInstanceId: string;
  agents: Map<string, Managed>;
  retiring: Map<string, { lifecycleUid: string }>;
  staticReconcileItems: Map<string, { alias: string; attempts: number; maxAttempts: number }>;
  staticReconcileSweepsInFlight: number;
  releaseStaticReconcileSweep: () => void;
  driveStaticRetirement: (a: { id: string; name: string; lifecycleUid: string }) => Promise<void>;
  retryStaticReconcile: (key: string) => Promise<void>;
  userMode: boolean;
  unrecordedCustody: Map<string, RuntimeReference>;
  spawnCustodied: (name: string, spec: unknown, cwd: string, reserved: RuntimeReference, slot: { id: string; lifecycleUid: string }) => Promise<AgentHandle>;
  staticReconcileRetryDelaysMs: readonly number[];
  staticLifecycleEvict?: (principal: string) => Promise<EvictionResult>;
  withLifecycleExecutor: Executor;
  deprovisionBroker: (a: { id: string; name: string; lifecycleUid: string }) => Promise<void>;
  despawnAuthorized: (a: Managed, graceful: boolean, trackNonAdmin: boolean, caller: string) => unknown;
  onAgentExit: (a: Managed) => void;
  deprovision: (a: { id: string; name: string; lifecycleUid: string; runtime?: RuntimeReference }) => Promise<void>;
  reconcileStaticLifecycles: () => Promise<void>;
  managerStatusData: () => ManagerStatus;
  freeSlot: (a: unknown, floor: boolean, cause: FreeSlotCause) => void;
};
M.auth = auth;
M.runtime = fakeRuntime;
M.managerInstanceId = "custody-smoke-instance";
M.staticReconcileRetryDelaysMs = [1_500, 1_500, 1_500];
M.ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: () => Promise.resolve(),
  getRoster: (): Presence[] =>
    [...M.agents.values()].map((a): Presence => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name, role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: a.lifecycleUid, ts: 0 })),
  requestDeliveryAdmin: requestDeliveryAdminZeroMemberships,
};
// A real broker kicks a principal's connections once; a re-eviction finds none, so it reports kicked 0.
const evictions = new Map<string, number[]>();
M.staticLifecycleEvict = async (principal) => {
  const seen = evictions.get(principal) ?? [];
  const kicked = seen.length === 0 ? 1 : 0;
  evictions.set(principal, [...seen, kicked]);
  return { principal, kicked, remaining: 0, scanComplete: true, verifiedGone: true };
};
// Count footprint cleanup per alias: the broker teardown is the cleanup's last step.
const cleanups = new Map<string, number>();
const deprovisionBroker = M.deprovisionBroker.bind(mgr);
M.deprovisionBroker = async (a) => {
  cleanups.set(a.name, (cleanups.get(a.name) ?? 0) + 1);
  await deprovisionBroker(a);
};
// A one-shot forced CAS failure on one alias's slot row, injected at the executor transport.
let failSlotCasFor: string | undefined;
// One-shot: on the second slot read inside one executor call, a racing writer swaps the row's reference.
let swapRuntimeOn: { alias: string; to: RuntimeReference } | undefined;
const withLifecycleExecutor = M.withLifecycleExecutor.bind(mgr);
M.withLifecycleExecutor = (pin, fn) => {
  let slotReads = 0;
  return withLifecycleExecutor(pin, (t) => fn({
    ...t,
    getRecord: async (key) => {
      const swap = swapRuntimeOn;
      if (swap === undefined || key !== staticSlotKey(DEV_OWNER, swap.alias) || ++slotReads !== 2) return t.getRecord(key);
      swapRuntimeOn = undefined;
      const cur = await readStaticSlot(t, DEV_OWNER, swap.alias);
      if (cur !== undefined) await casStaticSlot(t, { ...cur.row, runtime: swap.to }, cur.revision);
      return t.getRecord(key);
    },
    updateRecord: (key, value, rev) => {
      if (failSlotCasFor !== undefined && key === staticSlotKey(DEV_OWNER, failSlotCasFor)) {
        failSlotCasFor = undefined;
        return Promise.reject(new Error("smoke: forced slot CAS conflict"));
      }
      return t.updateRecord(key, value, rev);
    },
  }));
};

const quiet: Connector = { kind: "connector", name: "smoke-custody", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
// A child that ignores SIGTERM, so a graceful stop depends on the delayed SIGKILL.
const stubborn: Connector = {
  kind: "connector",
  name: "smoke-custody-stubborn",
  requires: ["node"],
  buildLaunch: () => ({ command: process.execPath, args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], env: { PATH: process.env.PATH ?? "" } }),
};
registry.register(quiet);
registry.register(stubborn);

async function withExecutor<T>(alias: string, actor: string, uid: string, fn: (t: LifecycleStateTransport) => Promise<T>): Promise<T> {
  const creds = await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor, lifecycleUid: uid, alias } });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    return await fn(staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space))));
  } finally {
    await nc.drain().catch(() => nc.close());
  }
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
/** dm durable and ACL row of one incarnation, read with provisioner authority. */
async function brokerFootprint(id: string, uid: string): Promise<{ durable: boolean; acl: boolean }> {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const jsm = await jetstreamManager(nc);
    const durable = await jsm.consumers.info(dmStream(space), dmDurable(DEV_OWNER, id, uid)).then(() => true, () => false);
    const acl = (await readAcl(await openAclRegistry(nc, space), principalKey(DEV_OWNER, id).key, uid)) !== undefined;
    return { durable, acl };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}
const item = (alias: string): ManagerStaticReconciliationFailure | undefined =>
  M.managerStatusData().staticReconciliation.failures.find((f) => f.alias === alias);
const REMEDY = /release-seat with this alias and lifecycleUid/;

async function spawnLive(alias: string, supervise = false): Promise<Managed> {
  const reply = await mgr.startAgent({ name: alias, agent: "smoke-custody", events: false, ...(supervise ? { supervise: { restarts: 5, windowMs: 60_000 } } : {}) });
  const a = M.agents.get(alias);
  if (!reply.ok || a === undefined) throw new Error(`spawn ${alias} failed: ${JSON.stringify(reply)}`);
  return a;
}
const refOf = (a: Managed): RuntimeReference => {
  if (a.handle.reference === undefined) throw new Error(`${a.name} has no custody reference`);
  return a.handle.reference;
};

const seatProcs: Array<Owned | undefined> = [];
try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ── Retained terminal ──────────────────────────────────────────────────────
  {
    const a = await spawnLive("retainer");
    const { id, lifecycleUid: uid } = a;
    plans.set(refOf(a).id, [UNPROVABLE]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("retainer")?.retainedReason !== undefined, 30_000);
    const slot = await readSlot("retainer");
    const ledger = await withExecutor("retainer", id, uid, async (t) => {
      const rows: CredentialLedgerRow[] = [];
      for (const cid of slot?.credentialIds ?? []) {
        const e = await t.getAuth(credRowKey(uid, cid));
        if (e !== undefined) rows.push(parseLedgerRow(e.value, credRowKey(uid, cid)));
      }
      const audit = await t.getRecord(recordSpecKey(RECORD_KINDS.lifecycle, [DEV_OWNER, id, uid]));
      return { rows, audit: audit !== undefined };
    });
    check("retained terminal: the slot stays terminalizing, every ledger row is revoked and the eviction audit is written",
      slot?.phase === "terminalizing" && ledger.rows.length > 0 && ledger.rows.every((r) => r.state === "revoked") && ledger.audit,
      { phase: slot?.phase, rows: ledger.rows.map((r) => r.state), audit: ledger.audit });
    const credsPath = a.secretPaths?.creds;
    const fp = await brokerFootprint(id, uid);
    check("retained terminal: the creds file, the dm durable and the ACL row remain", credsPath !== undefined && existsSync(credsPath) && fp.durable && fp.acl, { credsPath, fp });
    const intent = await withExecutor("retainer", id, uid, (t) =>
      writeStaticSlotIntent(t, { owner: DEV_OWNER, alias: "retainer", actor: id, lifecycleUid: uid, managerInstance: "smoke", ownerInstanceId: M.managerInstanceId }).then(() => "written", (e: unknown) => e instanceof EpEnvelopeError ? e.code : String(e)));
    check("retained terminal: writeStaticSlotIntent over the held slot throws failed-precondition", intent === "failed-precondition", intent);
    const it = item("retainer");
    check("retained terminal: status is refused, unprovable, the release remedy, no nextRetryAt, retainedCustody 1",
      it?.disposition === "refused" && it.retainedReason === "unprovable" && REMEDY.test(it.remedy ?? "") && it.nextRetryAt === undefined && M.managerStatusData().staticReconciliation.retainedCustody === 1, { it, count: M.managerStatusData().staticReconciliation.retainedCustody });
  }

  // ── Members remain, then reaped ────────────────────────────────────────────
  {
    const a = await spawnLive("membersok");
    plans.set(refOf(a).id, [MEMBERS, { outcome: "reaped", detail: "fake: group empty" }]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("membersok")?.retainedReason !== undefined, 30_000);
    const first = item("membersok");
    check("members remain: the first reap arms a retry and runs no cleanup",
      first?.disposition === "retry-scheduled" && first.nextRetryAt !== undefined && first.retainedReason === "members-remain" && (cleanups.get("membersok") ?? 0) === 0, { first, cleanups: cleanups.get("membersok") });
    await until(() => item("membersok")?.disposition === "recovered", 30_000);
    const done = item("membersok");
    check("members remain: the retry proves the seat gone, cleans up once, and recovers without retainedReason",
      done?.disposition === "recovered" && done.retainedReason === undefined && cleanups.get("membersok") === 1 && (await readSlot("membersok"))?.phase === "retired", { done, cleanups: cleanups.get("membersok") });
  }

  // ── Members remain, and the retry's eviction kicks nothing ─────────────────
  {
    const a = await spawnLive("rekick");
    plans.set(refOf(a).id, [MEMBERS, { outcome: "reaped", detail: "fake: group empty" }]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("rekick")?.disposition === "recovered" || item("rekick")?.disposition === "refused", 30_000);
    const done = item("rekick");
    const kicks = [...evictions.entries()].find(([p]) => p.endsWith(a.id))?.[1];
    check("members remain, re-kick 0: the retry's audit matches the first audit and the lifecycle retires",
      done?.disposition === "recovered" && kicks !== undefined && kicks.length >= 2 && kicks.at(-1) === 0 && (await readSlot("rekick"))?.phase === "retired", { done, kicks });
  }

  // ── Members remain past the budget ─────────────────────────────────────────
  {
    const a = await spawnLive("membersmax");
    plans.set(refOf(a).id, [MEMBERS]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("membersmax")?.disposition === "refused", 30_000);
    const it = item("membersmax");
    check("budget exhausted: members-remain at the last attempt is refused with the release remedy, never retry-exhausted",
      it?.disposition === "refused" && it.retainedReason === "members-remain" && it.attempts === it.maxAttempts && REMEDY.test(it.remedy ?? ""), it);
  }

  // ── Predecessor kept ───────────────────────────────────────────────────────
  {
    const a = await spawnLive("predkept", true);
    const prior = refOf(a);
    plans.set(prior.id, [UNPROVABLE]);
    const before = spawnCalls;
    M.onAgentExit(a);
    await until(() => item("predkept")?.retainedReason !== undefined, 30_000);
    const row = await readSlot("predkept");
    check("predecessor kept: an unproven predecessor spawns nothing, the row still names it, and status is retained",
      spawnCalls === before && row?.runtime?.id === prior.id && item("predkept")?.retainedReason === "unprovable", { spawned: spawnCalls - before, row: row?.runtime, prior, it: item("predkept") });
  }

  // ── Reservation is fatal ───────────────────────────────────────────────────
  {
    const a = await spawnLive("fatalres", true);
    const prior = refOf(a);
    const before = spawnCalls;
    failSlotCasFor = "fatalres";
    M.onAgentExit(a);
    await until(() => !M.retiring.has("fatalres") && !M.agents.has("fatalres"), 30_000);
    check("reservation is fatal: a forced recordSlotCustody CAS failure means runtime.spawn is never called",
      spawnCalls === before && failSlotCasFor === undefined && (await readSlot("fatalres"))?.runtime?.id === prior.id, { spawned: spawnCalls - before, row: (await readSlot("fatalres"))?.runtime });
  }

  // ── Failed restart ─────────────────────────────────────────────────────────
  {
    const a = await spawnLive("failrestart", true);
    const prior = refOf(a);
    plans.set(prior.id, [{ outcome: "reaped", detail: "fake: predecessor gone" }]);
    unknownPlan = UNPROVABLE; // the replacement's reference, minted inside the restart
    failNextSpawn = true;
    const mark = reaps.length;
    M.onAgentExit(a);
    await until(() => item("failrestart")?.retainedReason !== undefined, 30_000);
    unknownPlan = undefined;
    const row = await readSlot("failrestart");
    const after = reaps.slice(mark);
    const it = item("failrestart");
    check("failed restart: the terminal reaps the row's new reference (not the old handle's), and status is retained, never a plain Error",
      row?.runtime !== undefined && row.runtime.id !== prior.id && after.length === 2 && after[0] === prior.id && after[1] === row.runtime.id &&
        it?.disposition === "refused" && it.retainedReason === "unprovable" && /NOT proved gone/.test(it.lastError ?? ""), { row: row?.runtime, prior, after, it });
  }

  // ── Spawned under another reference ────────────────────────────────────────
  {
    const got: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    spawnAs = got;
    const mark = reaps.length;
    const reply = await mgr.startAgent({ name: "othref", agent: "smoke-custody", events: false });
    await until(async () => (await readSlot("othref"))?.phase === "retired", 30_000);
    const row = await readSlot("othref");
    check("spawned under another reference: the row names what was spawned and the terminal reaps exactly that",
      reply.ok === false && row?.runtime?.id === got.id && row.phase === "retired" && reaps.slice(mark).every((id) => id === got.id) && reaps.slice(mark).length >= 1, { reply, row, reaps: reaps.slice(mark) });
  }

  // ── Rowless lifecycle ──────────────────────────────────────────────────────
  {
    const actor = newIdentity().id;
    const uid = mintLifecycleUid();
    const ref: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    plans.set(ref.id, [UNPROVABLE]);
    await M.deprovision({ id: actor, name: "rowless", lifecycleUid: uid, runtime: ref });
    const row = await readSlot("rowless");
    const it = item("rowless");
    check("rowless lifecycle: the terminal writes a slot row, retains it, and status names the alias and lifecycleUid",
      row?.lifecycleUid === uid && row.phase === "terminalizing" && row.runtime?.id === ref.id && it?.lifecycleUid === uid && it.retainedReason === "unprovable", { row, it });
  }

  // ── No reference ───────────────────────────────────────────────────────────
  {
    const actor = newIdentity().id;
    const uid = mintLifecycleUid();
    await withExecutor("noref", actor, uid, async (t) => {
      await activateStaticLifecycle(t, { owner: DEV_OWNER, alias: "noref", actor, lifecycleUid: uid, managerInstance: "smoke", ownerInstanceId: M.managerInstanceId });
      const slot = await readStaticSlot(t, DEV_OWNER, "noref");
      if (slot === undefined) throw new Error("noref slot missing");
      await casStaticSlot(t, { ...slot.row, phase: "active" }, slot.revision);
    });
    const creds = agentLifecycleSecretFilePaths(workspaceRoot, space, "noref", uid).creds;
    if (creds === undefined) throw new Error("no creds path");
    mkdirSync(dirname(creds), { recursive: true });
    writeFileSync(creds, "smoke placeholder\n");
    await M.reconcileStaticLifecycles();
    const it = item("noref");
    check("no reference: a row with no runtime is refused as no-reference, and the creds file remains",
      it?.disposition === "refused" && it.retainedReason === "no-reference" && existsSync(creds) && (await readSlot("noref"))?.phase === "terminalizing", it);
  }

  // ── Late reference: the terminal reaps the row's reference as it stands after the latch ─
  {
    const a = await spawnLive("lateref");
    const early = refOf(a);
    const late: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    plans.set(early.id, [{ outcome: "reaped", detail: "fake: stale reference" }]);
    plans.set(late.id, [UNPROVABLE]);
    const mark = reaps.length;
    swapRuntimeOn = { alias: "lateref", to: late };
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("lateref")?.retainedReason !== undefined || reaps.length > mark && swapRuntimeOn === undefined && M.retiring.get("lateref") === undefined, 30_000);
    check("late reference: a reference recorded before the latch is the one reaped, and it retains",
      swapRuntimeOn === undefined && reaps.slice(mark).includes(late.id) && !reaps.slice(mark).includes(early.id) && item("lateref")?.retainedReason === "unprovable", { reaps: reaps.slice(mark), late, early, it: item("lateref") });
  }

  // ── Members remain while a sweep is in flight, outside its plan ────────────
  {
    const a = await spawnLive("membersweep");
    plans.set(refOf(a).id, [MEMBERS, { outcome: "reaped", detail: "fake: group empty" }]);
    M.staticReconcileSweepsInFlight++;
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("membersweep")?.retainedReason !== undefined, 30_000);
    M.releaseStaticReconcileSweep();
    await until(() => item("membersweep")?.disposition === "recovered", 30_000);
    check("members remain during a sweep: the sweep's end arms the deferred retry, and the item recovers",
      item("membersweep")?.disposition === "recovered" && (await readSlot("membersweep"))?.phase === "retired", item("membersweep"));
  }

  // ── A retained item clears when a direct terminal retires the lifecycle ────
  {
    const a = await spawnLive("clearme");
    const { id, lifecycleUid } = a;
    plans.set(refOf(a).id, [UNPROVABLE, { outcome: "reaped", detail: "fake: gone later" }]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("clearme")?.retainedReason !== undefined, 30_000);
    await M.driveStaticRetirement({ id, name: "clearme", lifecycleUid });
    const it = item("clearme");
    check("retired clears retained: a direct terminal that retires marks the item recovered and clears retainedReason and remedy",
      (await readSlot("clearme"))?.phase === "retired" && it?.disposition === "recovered" && it.retainedReason === undefined && it.remedy === undefined && it.lastError === undefined, it);
  }

  // ── A later non-reap failure keeps the retained remedy ─────────────────────
  {
    const a = await spawnLive("laterfail");
    plans.set(refOf(a).id, [UNPROVABLE, { outcome: "reaped", detail: "fake: gone later" }]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item("laterfail")?.retainedReason !== undefined, 30_000);
    const held = [...M.staticReconcileItems.values()].find((i) => i.alias === "laterfail");
    if (held === undefined) throw new Error("laterfail has no reconcile item");
    held.attempts = held.maxAttempts - 1;
    failSlotCasFor = "laterfail";
    await M.reconcileStaticLifecycles();
    const it = item("laterfail");
    check("later failure: a retained item that then exhausts its budget stays refused with the release remedy, never restart",
      failSlotCasFor === undefined && it?.disposition === "refused" && REMEDY.test(it.remedy ?? "") && /forced slot CAS/.test(it.lastError ?? ""), it);
  }

  // ── No static row: a mismatched spawn is reaped inline, never recorded ─────
  {
    const reserved: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    const got: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    const uid = mintLifecycleUid();
    const mark = reaps.length;
    spawnAs = got;
    M.userMode = true;
    const outcome = await M.spawnCustodied("nostatic", {}, workspaceRoot, reserved, { id: newIdentity().id, lifecycleUid: uid }).then(() => "spawned", (e: unknown) => String(e));
    M.userMode = false;
    check("no static row: a mismatched spawn reaps got inline before failing, and unrecordedCustody stays untouched",
      /spawned seat was reaped/.test(outcome) && reaps.slice(mark).join() === got.id && !M.unrecordedCustody.has(uid), { outcome, reaps: reaps.slice(mark) });
  }

  // ── A retry from a retained item finds the row retired, or moved ───────────
  for (const [alias, label] of [["retryret", "retired"], ["retrymove", "moved"]] as const) {
    const a = await spawnLive(alias);
    const { id, lifecycleUid } = a;
    plans.set(refOf(a).id, [UNPROVABLE]);
    M.despawnAuthorized(a, false, false, "smoke");
    await until(() => item(alias)?.retainedReason !== undefined, 30_000);
    const counted = M.managerStatusData().staticReconciliation.retainedCustody;
    await withExecutor(alias, id, lifecycleUid, async (t) => {
      const slot = await readStaticSlot(t, DEV_OWNER, alias);
      if (slot === undefined) throw new Error(`${alias} slot missing`);
      await casStaticSlot(t, label === "retired" ? { ...slot.row, phase: "retired" } : { ...slot.row, lifecycleUid: mintLifecycleUid() }, slot.revision);
    });
    await M.retryStaticReconcile(JSON.stringify([DEV_OWNER, alias, lifecycleUid]));
    const it = item(alias);
    const after = M.managerStatusData().staticReconciliation.retainedCustody;
    check(`retry from retained, row ${label}: retainedReason${label === "retired" ? " and remedy are" : " is"} cleared and retainedCustody drops it`,
      it !== undefined && it.retainedReason === undefined && (label === "moved" || it.remedy === undefined) && after === counted - 1, { it, counted, after });
  }

  // ── An unreserved runtime's restart records the replacement's reference, or stops it ──────
  {
    // A runtime that names its seats but reserves nothing (as tmux does): the row learns the
    // replacement's reference only after the spawn.
    const spawned: AgentHandle[] = [];
    M.runtime = {
      kind: "pty",
      spawn: (name: string) => {
        const h = fakeHandle(name, { kind: "pty", id: randomUUID().replaceAll("-", "") });
        spawned.push(h);
        return h;
      },
    };
    // A restart waits for a heartbeat newer than the exited seat's, so the roster must move.
    const getRoster = M.ep.getRoster as () => Presence[];
    M.ep.getRoster = (): Presence[] => getRoster().map((p) => ({ ...p, ts: Date.now() }));
    try {
      const a = await spawnLive("unres", true);
      const prior = refOf(a);
      M.onAgentExit(a);
      await until(() => spawned.length === 2 && M.agents.get("unres")?.handle === spawned[1], 30_000);
      const next = spawned[1]?.reference;
      await until(async () => (await readSlot("unres"))?.runtime?.id === next?.id, 10_000);
      const row = await readSlot("unres");
      check("unreserved restart: the slot row names the replacement's reference, not the exited seat's",
        next !== undefined && row?.runtime?.id === next.id && next.id !== prior.id, { row: row?.runtime, prior, next });

      const b = await spawnLive("unresfail", true);
      const before = spawned.length;
      failSlotCasFor = "unresfail";
      M.onAgentExit(b);
      await until(() => spawned.length > before && !M.agents.has("unresfail"), 30_000);
      const replacement = spawned[before];
      check("unreserved restart, recording refused: the replacement is stopped through its handle and the seat is retired",
        failSlotCasFor === undefined && replacement !== undefined && replacement.status() === "exited" && !M.agents.has("unresfail"),
        { cas: failSlotCasFor, spawned: spawned.length - before, status: replacement?.status(), managed: M.agents.has("unresfail") });
    } finally {
      M.ep.getRoster = getRoster;
      failSlotCasFor = undefined;
    }
  }

  // ── Failed escalation (real custodial pty, no layer 3) ─────────────────────
  {
    M.runtime = new CustodialPtyRuntime({ root: seatRoot });
    setCustodianTestSeam({ failEscalation: true });
    const reply = await mgr.startAgent({ name: "escalate", agent: "smoke-custody-stubborn", events: false });
    const a = M.agents.get("escalate");
    if (!reply.ok || a === undefined) throw new Error(`spawn escalate failed: ${JSON.stringify(reply)}`);
    const ref = refOf(a);
    const rec = readRecord(recordPath(seatRoot, ref.id));
    seatProcs.push(owned(rec.custodianPid, rec.custodianStart), owned(rec.childPid, rec.childStart));
    M.despawnAuthorized(a, true, false, "smoke");
    await until(() => item("escalate")?.retainedReason !== undefined, 30_000);
    const respawn = await mgr.startAgent({ name: "escalate", agent: "smoke-custody-stubborn", events: false });
    const credsPath = a.secretPaths?.creds;
    check("failed escalation: status is unprovable, the slot stays terminalizing, the alias is refused, and the creds file and seat directory remain",
      item("escalate")?.retainedReason === "unprovable" && (await readSlot("escalate"))?.phase === "terminalizing" && respawn.ok === false &&
        credsPath !== undefined && existsSync(credsPath) && existsSync(dirname(recordPath(seatRoot, ref.id))), { it: item("escalate"), respawn, credsPath });
    setCustodianTestSeam(undefined);
  }
} finally {
  for (const p of seatProcs) killOwned(p);
  await (mgr as unknown as { stop?: () => Promise<void> }).stop?.().catch(() => {});
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`CUSTODY FAIL-CLOSED SMOKE FAILED (${failures} failures)`);
  process.exit(1);
}
if (ran !== EXPECTED_CHECKS) {
  console.log(`CUSTODY FAIL-CLOSED SMOKE FAILED (ran ${ran} of ${EXPECTED_CHECKS} declared assertions)`);
  process.exit(1);
}
console.log(`CUSTODY FAIL-CLOSED SMOKE OK ✅ (${ran}/${EXPECTED_CHECKS} assertions)`);
process.exit(0);
