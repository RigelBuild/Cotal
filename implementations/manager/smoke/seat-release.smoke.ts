/**
 * Operator release over a real broker (seat-custody-retention § T4): the release-seat handler, its
 * record, the terminal it completes, and its refusals. The seat side is real files under a seat root.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
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
  recordStatusKey,
  readRecord,
  epAuthBucket,
  EpEnvelopeError,
  type Connector,
  type AgentHandle,
  type EpCommandDef,
  type Presence,
  type StaticManagedSlotRow,
  type EvictionResult,
  type LifecycleStateTransport,
  type RuntimeReference,
} from "@cotal-ai/core";
import { checkSeatRelease, removeSeatCustody, sealSeatLaunch } from "@cotal-ai/seat";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";
import type { ManagerStatus, ManagerStaticReconciliationFailure } from "../src/manager-service-contract.js";
import type { ReleasableRuntime, RuntimeReapEvidence, RuntimeReleaseCheck } from "../src/runtime/index.js";
import { staticLifecycleTransport, readStaticSlot, casStaticSlot, readStaticRelease, writeStaticRelease, type StaticLifecycleReleaseSpec } from "../src/static-lifecycle.js";
import { bootBroker } from "./_boot-broker.js";

let failures = 0;
let ran = 0;
/** Intent, not a measurement: one per cell assertion below. A shortfall means a cell stopped running. */
const EXPECTED_CHECKS = 26;
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

if (process.platform !== "linux") {
  console.log(`SEAT RELEASE SMOKE COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

const seatRoot = makeSeatRoot("release-");
const space = `release-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-release-ws-"));
const ALIASES = ["rel", "succ", "authz", "wrong", "foreign", "store", "crash", "after", "busy", "grant", "race", "unrec", "badnull", "badfield", "badalias"];
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const alias of ALIASES)
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${alias}.md`), `---\nname: ${alias}\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`);

/** One reap that parks until the test releases it: a retry held inside the terminal's cleanup. */
type Gate = { promise: Promise<void>; resolve: () => void };
// The smoke tsconfig's lib predates Promise.withResolvers.
function gate(): Gate {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
let reapHold: { id: string; reached: Gate; release: Gate } | undefined;
// ── A releasable fake runtime: every reap is unprovable; the seat is a real directory ──
const UNPROVABLE: RuntimeReapEvidence = { outcome: "retained", reason: "unprovable", detail: "fake: no contained proof" };
let sealOverride: RuntimeReleaseCheck | undefined;
let failRemoveOnce = false;
const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const fakeRuntime: ReleasableRuntime = {
  kind: "pty",
  reserve: () => ({ kind: "pty", id: randomUUID().replaceAll("-", "") }),
  spawn: (name, _spec, _cwd, reference): AgentHandle => {
    if (reference !== undefined) mkdirSync(join(seatRoot, reference.id), { recursive: true });
    let running = true;
    return { name, kind: "pty", reference, status: () => running ? "running" : "exited", stop: () => { running = false; }, waitForExit: async () => { running = false; }, interrupt: () => {}, attach: () => fakeSession };
  },
  reap: async (ref) => {
    const hold = reapHold;
    if (hold === undefined || hold.id !== ref.id) return UNPROVABLE;
    reapHold = undefined;
    hold.reached.resolve();
    await hold.release.promise;
    return UNPROVABLE;
  },
  checkRelease: (ref) => checkSeatRelease(seatRoot, ref.id),
  sealRelease: async (ref) => sealOverride ?? sealSeatLaunch(seatRoot, ref.id),
  removeCustody: (ref) => {
    if (failRemoveOnce) {
      failRemoveOnce = false;
      throw new Error("smoke: crash before the seat directory is removed");
    }
    removeSeatCustody(seatRoot, ref.id);
  },
};

type Managed = { id: string; name: string; lifecycleUid: string; handle: AgentHandle; secretPaths?: { creds?: string } };
type Executor = <T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>) => Promise<T>;
// The smoke drives private manager seams, as custody-fail-closed.smoke.ts does.
type Seams = {
  auth: unknown;
  runtime: unknown;
  ep: Record<string, unknown>;
  managerInstanceId: string;
  managerLifecycleUid: string;
  agents: Map<string, Managed>;
  userMode: boolean;
  staticReconcileRetryDelaysMs: readonly number[];
  staticLifecycleEvict?: (principal: string) => Promise<EvictionResult>;
  withLifecycleExecutor: Executor;
  deprovisionBroker: (a: { id: string; name: string; lifecycleUid: string }) => Promise<void>;
  despawnAuthorized: (a: Managed, graceful: boolean, trackNonAdmin: boolean, caller: string) => unknown;
  deprovision: (a: { id: string; name: string; lifecycleUid: string; runtime?: RuntimeReference }) => Promise<void>;
  driveStaticRetirement: (a: { id: string; name: string; lifecycleUid: string; runtime?: RuntimeReference }, surfaceFailure: boolean) => Promise<void>;
  unrecordedCustody: Map<string, RuntimeReference>;
  managerStatusData: () => ManagerStatus;
  managerServiceDefs: () => EpCommandDef[];
};
// A real broker kicks a principal's connections once; a re-eviction finds none, so it reports kicked 0.
const evictions = new Map<string, number>();
let failReleaseWrite = false;
let failBrokerOnce = false;
function wire(mgr: Manager): Seams {
  const M = mgr as unknown as Seams;
  M.auth = auth;
  M.runtime = fakeRuntime;
  M.managerInstanceId = "release-smoke-instance";
  M.staticReconcileRetryDelaysMs = [60_000];
  M.ep = {
    ref: () => ({ id: "smoke-mgr" }),
    on: () => {},
    off: () => {},
    waitForPresenceSnapshot: () => Promise.resolve(),
    getRoster: (): Presence[] =>
      [...M.agents.values()].map((a): Presence => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name, role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: a.lifecycleUid, ts: 0 })),
  };
  M.staticLifecycleEvict = async (principal) => {
    const seen = evictions.get(principal) ?? 0;
    evictions.set(principal, seen + 1);
    return { principal, kicked: seen === 0 ? 1 : 0, remaining: 0, scanComplete: true, verifiedGone: true };
  };
  const deprovisionBroker = M.deprovisionBroker.bind(mgr);
  M.deprovisionBroker = async (a) => {
    if (failBrokerOnce) {
      failBrokerOnce = false;
      throw new Error("smoke: crash after the seat directory was removed");
    }
    await deprovisionBroker(a);
  };
  const withLifecycleExecutor = M.withLifecycleExecutor.bind(mgr);
  M.withLifecycleExecutor = (pin, fn) => withLifecycleExecutor(pin, (t) => fn({
    ...t,
    createRecord: (key, value) => {
      if (failReleaseWrite && key === recordStatusKey(RECORD_KINDS.lifecycle, [pin.owner, pin.actor, pin.lifecycleUid]))
        return Promise.reject(new Error("smoke: the release record store failed"));
      return t.createRecord(key, value);
    },
  }));
  return M;
}

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
const M = wire(mgr);
const quiet: Connector = { kind: "connector", name: "smoke-release", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(quiet);

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
const readRelease = (r: Retained): Promise<StaticLifecycleReleaseSpec | undefined> =>
  withExecutor(r.alias, r.id, r.uid, (t) => readStaticRelease(t, DEV_OWNER, r.id, r.uid));
/** SPEC 13.4 merged read of the lifecycle record, through core's own reader; the error text on a throw. */
async function mergedRecord(r: { alias: string; id: string; uid: string }) {
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    return await readRecord(await new Kvm(nc).open(recordsBucket(space)), RECORD_KINDS.lifecycle, [DEV_OWNER, r.id, r.uid], { deadlineMs: 2_000 })
      .catch((e: unknown) => String(e));
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}
const item = (m: Seams, alias: string): ManagerStaticReconciliationFailure | undefined =>
  m.managerStatusData().staticReconciliation.failures.find((f) => f.alias === alias);

const operator = { owner: DEV_OWNER, actor: "operator_a", uid: mintLifecycleUid() };
/** Invoke release-seat through the real handler; the result or the envelope error code and message. */
async function release(m: Seams, args: Record<string, unknown>, caller = operator): Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }> {
  const def = m.managerServiceDefs().find((d) => d.command === "release-seat");
  if (def === undefined) throw new Error("release-seat is not registered");
  try {
    return { ok: true, data: await def.handler({ subject: { caller, command: "release-seat", target: { mode: "owner" } }, request: { args } } as unknown as Parameters<EpCommandDef["handler"]>[0]) };
  } catch (e) {
    return { ok: false, code: e instanceof EpEnvelopeError ? e.code : "thrown", message: (e as Error).message };
  }
}

type Retained = { alias: string; id: string; uid: string; ref: RuntimeReference; creds: string | undefined };
async function retain(m: Seams, owner: Manager, alias: string): Promise<Retained> {
  const reply = await owner.startAgent({ name: alias, agent: "smoke-release", events: false });
  const a = m.agents.get(alias);
  if (!reply.ok || a === undefined || a.handle.reference === undefined) throw new Error(`spawn ${alias} failed: ${JSON.stringify(reply)}`);
  m.despawnAuthorized(a, false, false, "smoke");
  if (!(await until(() => item(m, alias)?.retainedReason !== undefined, 30_000))) throw new Error(`${alias} never retained`);
  return { alias, id: a.id, uid: a.lifecycleUid, ref: a.handle.reference, creds: a.secretPaths?.creds };
}
const seatDir = (r: Retained): boolean => existsSync(join(seatRoot, r.ref.id));
const fenceSealed = (r: Retained): boolean => existsSync(join(seatRoot, `.launch-${r.ref.id}`)) && readFileSync(join(seatRoot, `.launch-${r.ref.id}`), "utf8") === "sealed";
const argsOf = (r: Retained, reason = "operator confirmed the processes are gone") => ({ alias: r.alias, lifecycleUid: r.uid, reason });

let successor: Manager | undefined;
try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ── Release completes the terminal and frees the alias ─────────────────────
  {
    const r = await retain(M, mgr, "rel");
    const out = await release(M, argsOf(r));
    const rec = await readRelease(r);
    check("release: the slot retires, the seat directory and creds go, the fence stays sealed, and the item recovers",
      out.ok && (await readSlot("rel"))?.phase === "retired" && !seatDir(r) && fenceSealed(r) && r.creds !== undefined && !existsSync(r.creds) && item(M, "rel")?.disposition === "recovered", { out, slot: await readSlot("rel"), it: item(M, "rel") });
    check("operator from the caller: the recorded operator is the subject caller tuple",
      rec?.operator.owner === operator.owner && rec.operator.actor === operator.actor && rec.operator.uid === operator.uid && rec.managerProcessUid === M.managerLifecycleUid, rec);
    const merged = await mergedRecord(r);
    check("status contract, audit present: readRecord of the lifecycle returns the audit and the release status observing it",
      typeof merged !== "string" && merged?.status !== undefined && merged.status.observedSpecRevision === merged.spec.revision, merged);
    const again = await mgr.startAgent({ name: "rel", agent: "smoke-release", events: false });
    check("release frees the alias: a same-name spawn succeeds", again.ok, again);
    const def = M.managerServiceDefs().find((d) => d.command === "release-seat");
    check("operator from the payload: an operator field fails the input schema",
      def !== undefined && def.contract.input.validate(argsOf(r)) === true && def.contract.input.validate({ ...argsOf(r), operator }) === false);
  }

  // ── Authorization ──────────────────────────────────────────────────────────
  {
    const r = await retain(M, mgr, "authz");
    M.userMode = true; // no auth state on disk: the caller's current scope carries no admin
    const out = await release(M, argsOf(r));
    M.userMode = false;
    check("authorization: a caller without admin is permission-denied and no record is written",
      !out.ok && out.code === "permission-denied" && (await readRelease(r)) === undefined && seatDir(r) && !fenceSealed(r), out);
  }

  // ── Wrong incarnation or owner ─────────────────────────────────────────────
  {
    const r = await retain(M, mgr, "wrong");
    const out = await release(M, { ...argsOf(r), lifecycleUid: mintLifecycleUid() });
    check("wrong incarnation: a lifecycleUid mismatch is refused, writes nothing and seals nothing",
      !out.ok && /a release pins one incarnation/.test(out.message) && (await readRelease(r)) === undefined && seatDir(r) && !fenceSealed(r), out);
    const f = await retain(M, mgr, "foreign");
    await withExecutor("foreign", f.id, f.uid, async (t) => {
      const slot = await readStaticSlot(t, DEV_OWNER, "foreign");
      if (slot === undefined) throw new Error("foreign slot missing");
      await casStaticSlot(t, { ...slot.row, ownerInstanceId: "another-manager" }, slot.revision);
    });
    const other = await release(M, argsOf(f));
    check("wrong owner: a row whose ownerInstanceId names another manager is refused and writes nothing",
      !other.ok && /belongs to manager instance another-manager/.test(other.message) && (await readRelease(f)) === undefined && seatDir(f) && !fenceSealed(f), other);
  }

  // ── Store failure, then retry ──────────────────────────────────────────────
  {
    const r = await retain(M, mgr, "store");
    failReleaseWrite = true;
    const out = await release(M, argsOf(r));
    failReleaseWrite = false;
    check("store failure: a failed release write leaves the seat directory, the creds file and the terminalizing slot",
      !out.ok && seatDir(r) && r.creds !== undefined && existsSync(r.creds) && (await readSlot("store"))?.phase === "terminalizing" && (await readRelease(r)) === undefined, out);
    const retry = await release(M, argsOf(r));
    check("store failure: a retry over the sealed fence releases the seat", retry.ok && (await readSlot("store"))?.phase === "retired" && !seatDir(r), retry);
  }

  // ── Crash after the record, then after removal ─────────────────────────────
  {
    const r = await retain(M, mgr, "crash");
    failRemoveOnce = true;
    const first = await release(M, argsOf(r));
    const rec1 = await readRelease(r);
    check("crash after the record: the record exists, the seat directory and slot remain",
      !first.ok && rec1 !== undefined && seatDir(r) && (await readSlot("crash"))?.phase === "terminalizing", first);
    const otherReason = await release(M, argsOf(r, "a different reason"));
    const otherOperator = await release(M, argsOf(r), { ...operator, actor: "operator_b" });
    check("crash and retry: a different reason or operator is rejected without deletion",
      !otherReason.ok && otherReason.code === "already-exists" && !otherOperator.ok && otherOperator.code === "already-exists" && seatDir(r) && r.creds !== undefined && existsSync(r.creds), { otherReason, otherOperator });
    const retry = await release(M, argsOf(r));
    const rec2 = await readRelease(r);
    check("crash after the record: the same intent finishes on retry and reuses the record's timestamp",
      retry.ok && rec2?.timestamp === rec1?.timestamp && (await readSlot("crash"))?.phase === "retired" && !seatDir(r), { retry, rec1, rec2 });

    const s = await retain(M, mgr, "after");
    failBrokerOnce = true;
    const crashed = await release(M, argsOf(s));
    check("crash after removal: the seat directory is gone and the slot stays terminalizing",
      !crashed.ok && !seatDir(s) && (await readSlot("after"))?.phase === "terminalizing", crashed);
    const done = await release(M, argsOf(s));
    check("crash after removal: the retry finishes the terminal", done.ok && (await readSlot("after"))?.phase === "retired", done);
  }

  // ── Concurrent create loser ────────────────────────────────────────────────
  {
    const actor = newIdentity().id;
    const uid = mintLifecycleUid();
    const spec: StaticLifecycleReleaseSpec = {
      v: 1, principal: principalKey(DEV_OWNER, actor).key, alias: "grant", lifecycleUid: uid, operator, reason: "race",
      ownerInstanceId: M.managerInstanceId, managerProcessUid: "winner", timestamp: new Date(0).toISOString(),
    };
    const outcome = await withExecutor("grant", actor, uid, async (t) => {
      await writeStaticRelease(t, spec);
      const read = await readStaticRelease(t, DEV_OWNER, actor, uid);
      const same = await writeStaticRelease(t, { ...spec, managerProcessUid: "loser", timestamp: new Date().toISOString() }).then(() => "ok", (e: unknown) => String(e));
      const differ = await writeStaticRelease(t, { ...spec, reason: "another race" }).then(() => "ok", (e: unknown) => e instanceof EpEnvelopeError ? e.code : String(e));
      return { read, same, differ };
    });
    check("executor grant: on a real broker the lifecycle executor creates and reads the release record",
      outcome.read?.lifecycleUid === uid && outcome.read.reason === "race", outcome.read);
    check("concurrent create loser: the same intent is accepted and a different one is already-exists",
      outcome.same === "ok" && outcome.differ === "already-exists", outcome);
  }

  // ── Launch in progress ─────────────────────────────────────────────────────
  {
    const r = await retain(M, mgr, "busy");
    sealOverride = { ok: false, reason: "launch-in-progress", detail: "smoke: the fence is held" };
    const out = await release(M, argsOf(r));
    sealOverride = undefined;
    check("launch in progress: the release refuses with launch-in-progress and writes no record",
      !out.ok && /launch-in-progress/.test(out.message) && (await readRelease(r)) === undefined && seatDir(r) && (await readSlot("busy"))?.phase === "terminalizing", out);
  }

  // ── Rowless lifecycle ──────────────────────────────────────────────────────
  {
    const actor = newIdentity().id;
    const uid = mintLifecycleUid();
    const ref: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    mkdirSync(join(seatRoot, ref.id));
    await M.deprovision({ id: actor, name: "rowless", lifecycleUid: uid, runtime: ref });
    const r: Retained = { alias: "rowless", id: actor, uid, ref, creds: undefined };
    const out = await release(M, argsOf(r));
    check("rowless lifecycle: the slot T3 wrote releases like any other",
      out.ok && (await readSlot("rowless"))?.phase === "retired" && !seatDir(r), out);
    const merged = await mergedRecord(r);
    check("status contract, empty holders: readRecord of the lifecycle returns the empty audit and the release status",
      typeof merged !== "string" && merged?.status !== undefined && merged.status.observedSpecRevision === merged.spec.revision, merged);
  }

  // ── A retry held inside cleanup races the release ──────────────────────────
  {
    const r = await retain(M, mgr, "race");
    const reached = gate();
    const hold = { id: r.ref.id, reached, release: gate() };
    reapHold = hold;
    const retry = M.driveStaticRetirement({ id: r.id, name: "race", lifecycleUid: r.uid, runtime: r.ref }, false);
    await reached.promise;
    const pending = release(M, argsOf(r));
    await sleep(300);
    hold.release.resolve();
    await retry;
    const out = await pending;
    const it = item(M, "race");
    check("race: a retry held inside cleanup and a concurrent release end retired and recovered with no retainedReason",
      out.ok && (await readSlot("race"))?.phase === "retired" && it?.disposition === "recovered" && it.retainedReason === undefined, { out, it });
  }

  // ── An unrecorded reference refuses the release ────────────────────────────
  {
    const r = await retain(M, mgr, "unrec");
    const ghost: RuntimeReference = { kind: "pty", id: randomUUID().replaceAll("-", "") };
    M.unrecordedCustody.set(r.uid, ghost);
    const out = await release(M, argsOf(r));
    check("unrecorded custody: the release refuses, names the unrecorded reference, and writes nothing",
      !out.ok && out.message.includes(ghost.id) && (await readRelease(r)) === undefined && seatDir(r) && !fenceSealed(r), out);
    M.unrecordedCustody.delete(r.uid);
  }

  // ── A malformed or mismatched release record never removes custody ─────────
  for (const [alias, label, forge] of [
    ["badnull", "a JSON null", () => null],
    ["badfield", "a missing field", (s: Record<string, unknown>) => { const { reason: _, ...rest } = s; return rest; }],
    ["badalias", "a mismatched alias", (s: Record<string, unknown>) => ({ ...s, alias: "someone-else" })],
  ] as const) {
    const r = await retain(M, mgr, alias);
    const good = {
      v: 1, principal: principalKey(DEV_OWNER, r.id).key, alias, lifecycleUid: r.uid, operator, reason: "forged",
      ownerInstanceId: M.managerInstanceId, managerProcessUid: "forger", timestamp: new Date().toISOString(), observedSpecRevision: 0,
    };
    await withExecutor(alias, r.id, r.uid, (t) => t.createRecord(recordStatusKey(RECORD_KINDS.lifecycle, [DEV_OWNER, r.id, r.uid]), forge(good)));
    const terminal = await M.driveStaticRetirement({ id: r.id, name: alias, lifecycleUid: r.uid, runtime: r.ref }, true).then(() => "retired", (e: unknown) => String(e));
    check(`malformed release (${label}): the terminal refuses, the slot stays terminalizing, and the seat directory and creds remain`,
      /release record .* is (malformed|mismatched)/.test(terminal) && (await readSlot(alias))?.phase === "terminalizing" && seatDir(r) && r.creds !== undefined && existsSync(r.creds), terminal);
  }

  // ── Successor release ──────────────────────────────────────────────────────
  {
    const r = await retain(M, mgr, "succ");
    await mgr.stop().catch(() => {});
    successor = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
    const S = wire(successor);
    const out = await release(S, argsOf(r));
    const rec = await readRelease(r);
    check("successor release: a restarted manager with the same instance id and a new process uid releases its predecessor's seat",
      S.managerLifecycleUid !== M.managerLifecycleUid && out.ok && rec?.managerProcessUid === S.managerLifecycleUid && (await readSlot("succ"))?.phase === "retired" && !seatDir(r),
      { out, rec, slot: await readSlot("succ") });
  }
} finally {
  await mgr.stop().catch(() => {});
  await successor?.stop().catch(() => {});
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`SEAT RELEASE SMOKE FAILED (${failures} failures)`);
  process.exit(1);
}
if (ran !== EXPECTED_CHECKS) {
  console.log(`SEAT RELEASE SMOKE FAILED (ran ${ran} of ${EXPECTED_CHECKS} declared assertions)`);
  process.exit(1);
}
console.log(`SEAT RELEASE SMOKE OK ✅ (${ran}/${EXPECTED_CHECKS} assertions)`);
process.exit(0);
