/**
 * Placement participant operations over the NATS wire, with the placement ports INJECTED: the
 * reconciler, authenticator and role-policy ports are set here; the production auth bin does not
 * set them, so this exercises the auth side of the wire, not production composition.
 *
 * The four operations (`verify-placement-enrollment`, `enrollment-effect-status`,
 * `close-enrollment-effect`, `retire-placement-enrollment`) are driven by a caller credential
 * minted with the `reconciler` profile.
 *
 * Proven:
 *  1. admission. Broker-level refusals: a manager-caller is refused at the auth describe, and a
 *     seat (agent) is refused at each command publish. Auth-level refusal: a reconciler-profile
 *     credential minted for ANOTHER principal is admitted by the broker and refused by auth's own
 *     reconciler check. The reconciler is admitted on every command.
 *  2. lost-reply replay: the close reaches auth and auth answers (seen on the wire), but the
 *     caller drops the reply; the retry gets the same answer and the effect exists once.
 *  3. cancellation: a close stalled inside auth is cancelled after publish; the caller is told the
 *     outcome is unknown, no effect exists while it is stalled, and the effect state read after
 *     the cancel is the one auth then committed.
 *  4. unrelated-seat progress: one caller's close is stalled in flight inside auth while a distinct
 *     caller's close on another effect completes; the stalled close completes once released.
 *
 * Every wait is event-gated (the command publish, a reply observed on the wire, or a held lock),
 * each bounded by a deadline. A stall is a held effect lock, never a sleep.
 *
 * Not covered from the design's auth task: authority renewal (owned by the renewal work), and
 * manager isolation beyond the broker-level manager refusal in case 1.
 *
 * Run: pnpm smoke:placement-wire:auth   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  AUTH_ENDPOINT, EP_CMD_CLOSE_ENROLLMENT_EFFECT, EP_CMD_ENROLLMENT_EFFECT_STATUS,
  EP_CMD_RETIRE_PLACEMENT_ENROLLMENT, EP_CMD_VERIFY_PLACEMENT_ENROLLMENT,
  EpEnvelopeError, acquireLockAsync, createEndpointStreams, createSpaceAuth, contractDigest, DEV_OWNER,
  ensureAuthorityStores, epAuthBucket, epCallerReplyFilter, epPlaneTokens, epgateKey, idFromCreds, invokeCommand,
  isReachable, mintCreds, mintLifecycleUid, newIdentity, principalKey, resolveService, serverConfig,
  remoteManagerActors, spacePrefix, type EpCaller, type HeldLock,
} from "@cotal-ai/core";
import { openAuthAuthorityPlane, type ServiceAuthenticator, type ReconcilerPort, type RolePolicyPort } from "../src/index.js";
import { openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

type PlacementReply =
  | { ok: true; data: EffectView }
  | { ok: false; code: string; message: string; outcome?: string };

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `pwire-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
const journal = join(dir, "placement-enrollments");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv: ChildProcess = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);
const awaitExit = (proc: ChildProcess, timeoutMs = 3000): Promise<void> => {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  proc.once("exit", () => resolve());
  setTimeout(resolve, timeoutMs);
  return promise;
};

const OWNER = DEV_OWNER;
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = (): void => {};

// ---- the reconciler service principal; two distinct caller triples (uids) for case 4 --------
const RECONCILER: EpCaller = { owner: OWNER, actor: "reconciler", uid: mintLifecycleUid() };
const RECONCILER_2: EpCaller = { owner: OWNER, actor: "reconciler", uid: mintLifecycleUid() };
const RECONCILER_KEY = principalKey(RECONCILER.owner, RECONCILER.actor).key;
// A reconciler-shaped credential for ANOTHER principal: the broker admits it, auth must not.
const IMPOSTOR: EpCaller = { owner: OWNER, actor: "reconcilerB", uid: mintLifecycleUid() };

// ---- non-reconciler callers, refused by the broker -------------------------------------------
const MGR_SERVE = newIdentity();
const MGR: EpCaller = { owner: OWNER, actor: MGR_SERVE.id, uid: mintLifecycleUid() };
const MGR_INST = mintLifecycleUid();
const SERVE_EPOCH = 1;
const SEAT: EpCaller = { owner: OWNER, actor: "seatA", uid: mintLifecycleUid() };

// Admits exactly one principal: the reconciler's full owner.actor key.
const authenticator: ServiceAuthenticator = {
  authenticateService: async ({ transportPrincipal }) => ({
    principal: transportPrincipal === RECONCILER_KEY ? "reconciler" : "unknown",
  }),
};
// No case needs an accepted intent or role policy; both ports must exist or the rail answers
// `unimplemented`, so they are injected and fail loudly if called.
const reconciler: ReconcilerPort = {
  acceptedIntent: async () => { throw new EpEnvelopeError("failed-precondition", "no accepted intent in this smoke"); },
};
const rolePolicy: RolePolicyPort = {
  enrollmentAcl: async () => { throw new EpEnvelopeError("failed-precondition", "no role policy in this smoke"); },
};

const RETIRE_OPID = randomUUID();
const EFFECT_ID = randomUUID();
const FENCE_ID = randomUUID();
const IDENTITY = {
  acceptanceId: randomUUID(), enrollmentOperationId: randomUUID(), enrollmentRef: "ref-wire",
  target: { seatName: "seatA", generation: 1, lifecycle: { space, owner: OWNER, actor: "seatA", lifecycleUid: mintLifecycleUid() } },
  intentDigest: contractDigest({ wire: "placement" }),
};
const CLAIM = {
  accountPublicKey: auth.account.pub, instanceId: MGR_INST, managerLifecycleUid: MGR.uid,
  assignmentRevision: 1, currentRegistrationRevision: 1, serveEpoch: SERVE_EPOCH,
};

async function connectWith(creds: string): Promise<NatsConnection> {
  return connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
    maxReconnectAttempts: 0,
  });
}

/** A `reconciler`-profile connection for `caller` (its own owner.actor and uid). */
async function reconcilerConnection(caller: EpCaller): Promise<NatsConnection> {
  return connectWith(await mintCreds(auth, newIdentity(), "reconciler", {
    principal: { owner: caller.owner, actor: caller.actor }, reconciler: caller, expiresInSeconds: 3600,
  }));
}

/** A non-reconciler connection: a manager-caller or an agent (seat) credential for `caller`. */
async function otherConnection(profile: "agent" | "manager-caller", caller: EpCaller): Promise<NatsConnection> {
  return connectWith(profile === "agent"
    ? await mintCreds(auth, newIdentity(), "agent", { principal: { owner: caller.owner, actor: caller.actor }, lifecycleUid: caller.uid, endpointCapabilities: [] })
    : await mintCreds(auth, newIdentity(), "manager-caller", {
      principal: { owner: caller.owner, actor: caller.actor }, lifecycleUid: caller.uid,
      managerInstanceId: MGR_INST, expiresInSeconds: 3600,
    }));
}

/** The class-rail subject prefix of `command`'s own request: never matches the describe. */
const commandPrefix = (caller: EpCaller, command: string): string =>
  `${spacePrefix(space)}.${epPlaneTokens(caller).join(".")}.one.${AUTH_ENDPOINT}.${command}.`;

/** Run one placement command. `onCommandPublished` fires synchronously right after the command's
 *  own request is published (the describe from `resolveService` never triggers it). */
async function placement(
  nc: NatsConnection,
  caller: EpCaller,
  command: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; deadlineMs?: number; onCommandPublished?: () => void } = {},
): Promise<PlacementReply> {
  const prefix = commandPrefix(caller, command);
  const original = nc.publish;
  if (opts.onCommandPublished) {
    const hook = opts.onCommandPublished;
    nc.publish = (subject, payload, pubOpts) => {
      original.call(nc, subject, payload, pubOpts);
      if (subject.startsWith(prefix)) hook();
    };
  }
  try {
    const service = await resolveService(nc, space, AUTH_ENDPOINT, caller, { deadlineMs: 10_000 });
    const attributed = await invokeCommand(nc, space, service, command, args, {
      deadlineMs: opts.deadlineMs ?? 8_000,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const r = attributed.reply;
    if (r.ok) return { ok: true, data: effectView(r.data) };
    return { ok: false, code: r.error.code, message: r.error.message, ...(r.error.outcome ? { outcome: r.error.outcome } : {}) };
  } catch (e) {
    if (e instanceof EpEnvelopeError) return { ok: false, code: e.code, message: e.message, ...(e.outcome ? { outcome: e.outcome } : {}) };
    throw e;
  } finally {
    nc.publish = original;
  }
}

/** The status-view fields the cases read; every other reply field is ignored. */
type EffectView = { effectId?: unknown; state?: unknown; noLateEffects?: unknown };
function effectView(v: unknown): EffectView {
  if (typeof v !== "object" || v === null) return {};
  const { effectId, state, noLateEffects } = v as EffectView; // SAFETY: an object; each field stays unknown
  return { effectId, state, noLateEffects };
}

/** The data of a successful reply, or undefined. */
function dataOf(reply: PlacementReply): EffectView | undefined {
  return reply.ok ? reply.data : undefined;
}

/** True when the caller saw a cancel AFTER its command was published (outcome unknown). */
const cancelledAfterSend = (r: PlacementReply): boolean =>
  r.ok === false && r.code === "unavailable" && r.outcome === "unknown" && r.message.includes("observation cancelled");

/** Bound an event wait; the bound is a failure deadline, not a pacing sleep. */
async function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: t, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
}

let wide: AuthorityClient | undefined;

/** Observe auth's replies to `caller` on the wire (the harness sees what the caller may drop).
 *  Resolves with the reply data for `effectId` the first time auth answers it. */
function watchReply(caller: EpCaller, effectId: string): { reply: Promise<EffectView>; stop(): void } {
  if (!wide) throw new Error("harness client not open");
  const { promise, resolve } = Promise.withResolvers<EffectView>();
  const sub = wide.nc.subscribe(epCallerReplyFilter(space, caller), {
    callback: (err, msg) => {
      if (err) return;
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(msg.data)); } catch { return; }
      if (typeof body === "object" && body !== null && "ok" in body && body.ok === true && "data" in body) {
        const data = effectView(body.data);
        if (data.effectId === effectId) resolve(data);
      }
    },
  });
  return { reply: promise, stop: () => sub.unsubscribe() };
}

/** Hold an effect's lock from the harness so auth's close for it stalls in flight. */
const holdEffect = (effectId: string): Promise<HeldLock> =>
  acquireLockAsync(join(journal, `${effectId}.effect.lock`), { label: "smoke stall", waitMs: 5_000 });
const closedOnDisk = (effectId: string): boolean => existsSync(join(journal, `${effectId}.closed.json`));

let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [">"] }), log: quiet });
  const jsm = await jetstreamManager(wide.nc);
  const kvm = new Kvm(wide.nc);
  await ensureAuthorityStores(jsm, kvm, space);
  await createEndpointStreams(jsm, kvm, space);
  // The serve-issuance gate the rail reads for the manager instance (see auth-admin.smoke.ts).
  const epKv = await kvm.open(epAuthBucket(space));
  await epKv.put(epgateKey("manager", MGR_INST), new TextEncoder().encode(JSON.stringify({
    state: "open", generation: 1, processEpoch: SERVE_EPOCH, registrationRevision: 1, nameAuthorityRevision: 1,
    principal: principalKey(OWNER, remoteManagerActors(MGR_INST).serve).key,
  })));

  plane = await openAuthAuthorityPlane({
    server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: quiet,
    placementReconciler: reconciler, placementAuthenticator: authenticator, placementRolePolicy: rolePolicy,
  });

  console.log("1. admission (broker-level and auth-level refusals; reconciler admitted)");
  {
    const commands: { name: string; args: Record<string, unknown> }[] = [
      { name: EP_CMD_VERIFY_PLACEMENT_ENROLLMENT, args: { identity: IDENTITY, claim: CLAIM } },
      { name: EP_CMD_ENROLLMENT_EFFECT_STATUS, args: { effectId: EFFECT_ID } },
      { name: EP_CMD_CLOSE_ENROLLMENT_EFFECT, args: { effectId: EFFECT_ID, fenceId: FENCE_ID } },
      { name: EP_CMD_RETIRE_PLACEMENT_ENROLLMENT, args: { operationId: RETIRE_OPID, identity: IDENTITY, fenceId: FENCE_ID } },
    ];
    const mgr = await otherConnection("manager-caller", MGR);
    try {
      const reply = await placement(mgr, MGR, EP_CMD_ENROLLMENT_EFFECT_STATUS, { effectId: EFFECT_ID }, { deadlineMs: 6_000 });
      check("broker-level: a manager-caller is refused at the auth describe, before any command",
        reply.ok === false && reply.code === "permission-denied" && reply.message.includes(`the describe for ${AUTH_ENDPOINT} was REFUSED BY THE BROKER`), reply);
    } finally { await mgr.close().catch(() => {}); }
    const seat = await otherConnection("agent", SEAT);
    try {
      for (const cmd of commands) {
        const reply = await placement(seat, SEAT, cmd.name, cmd.args, { deadlineMs: 6_000 });
        check(`broker-level: a seat is refused at the ${cmd.name} publish`,
          reply.ok === false && reply.code === "permission-denied" && reply.outcome === "not-executed"
            && reply.message.includes(`the call for ${AUTH_ENDPOINT}.${cmd.name} was REFUSED BY THE BROKER`), reply);
      }
    } finally { await seat.close().catch(() => {}); }
    const impostor = await reconcilerConnection(IMPOSTOR);
    try {
      for (const cmd of commands) {
        const reply = await placement(impostor, IMPOSTOR, cmd.name, cmd.args, { deadlineMs: 6_000 });
        check(`auth-level: a reconciler credential for another principal is refused by auth on ${cmd.name}`,
          reply.ok === false && reply.code === "permission-denied" && reply.outcome === "not-executed"
            && reply.message.includes("enrollment participant requires the reconciler service"), reply);
      }
      check("auth-level: the other principal's refused close left no effect", !closedOnDisk(EFFECT_ID));
    } finally { await impostor.close().catch(() => {}); }
    const nc = await reconcilerConnection(RECONCILER);
    try {
      const status = await placement(nc, RECONCILER, EP_CMD_ENROLLMENT_EFFECT_STATUS, { effectId: EFFECT_ID });
      check("reconciler is admitted on enrollment-effect-status (answers pending)", dataOf(status)?.state === "pending", status);
      const close = await placement(nc, RECONCILER, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId: EFFECT_ID, fenceId: FENCE_ID });
      check("reconciler is admitted on close-enrollment-effect (closes the fresh effect)", dataOf(close)?.state === "cancelled", close);
      const verify = await placement(nc, RECONCILER, EP_CMD_VERIFY_PLACEMENT_ENROLLMENT, { identity: IDENTITY, claim: CLAIM });
      check("reconciler is admitted on verify-placement-enrollment (handler: not durably committed)",
        verify.ok === false && verify.code === "failed-precondition" && verify.message.includes("not durably committed"), verify);
      const retire = await placement(nc, RECONCILER, EP_CMD_RETIRE_PLACEMENT_ENROLLMENT, { operationId: RETIRE_OPID, identity: IDENTITY, fenceId: FENCE_ID });
      check("reconciler is admitted on retire-placement-enrollment (handler: unknown identity)",
        retire.ok === false && retire.code === "permission-denied" && retire.message.includes("unknown enrollment identity"), retire);
    } finally { await nc.close().catch(() => {}); }
  }

  console.log("2. lost-reply replay (auth applies the close, the caller drops the reply, the retry replays)");
  {
    const nc = await reconcilerConnection(RECONCILER);
    const effectId = randomUUID(), fenceId = randomUUID();
    const watch = watchReply(RECONCILER, effectId);
    try {
      const ac = new AbortController();
      let sent = false;
      const dropped = await placement(nc, RECONCILER, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId, fenceId },
        { signal: ac.signal, onCommandPublished: () => { sent = true; ac.abort(); } });
      check("the first close was published, and the caller dropped its reply (outcome unknown)",
        sent && cancelledAfterSend(dropped), { sent, dropped });
      const lost = await within(watch.reply, 10_000, "auth's reply to the first close");
      check("auth answered the first close on the wire (the effect was applied)",
        lost.state === "cancelled" && lost.noLateEffects === true && closedOnDisk(effectId), lost);
      const retry = await placement(nc, RECONCILER, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId, fenceId });
      check("the retry gets the same answer as the lost reply",
        retry.ok && retry.data.state === lost.state && retry.data.noLateEffects === lost.noLateEffects && retry.data.effectId === effectId, retry);
      const status = await placement(nc, RECONCILER, EP_CMD_ENROLLMENT_EFFECT_STATUS, { effectId });
      check("the effect exists exactly once (status cancelled, no late effects)",
        dataOf(status)?.state === "cancelled" && dataOf(status)?.noLateEffects === true, status);
    } finally { watch.stop(); await nc.close().catch(() => {}); }
  }

  console.log("3. cancellation (close stalled in auth, cancelled after publish, then the state is read)");
  {
    const nc = await reconcilerConnection(RECONCILER);
    const effectId = randomUUID(), fenceId = randomUUID();
    const watch = watchReply(RECONCILER, effectId);
    let lease: HeldLock | undefined = await holdEffect(effectId);
    try {
      const ac = new AbortController();
      let sent = false;
      const outcome = await placement(nc, RECONCILER, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId, fenceId },
        { signal: ac.signal, onCommandPublished: () => { sent = true; ac.abort(); } });
      check("the close was published and the cancelled caller is told the outcome is unknown",
        sent && cancelledAfterSend(outcome), { sent, outcome });
      check("while the close is stalled in auth, no effect exists", !closedOnDisk(effectId));
      lease.release(); lease = undefined;
      const landed = await within(watch.reply, 40_000, "auth's reply to the cancelled close");
      check("after release, auth completes the cancelled caller's close", landed.state === "cancelled", landed);
      const status = await placement(nc, RECONCILER, EP_CMD_ENROLLMENT_EFFECT_STATUS, { effectId });
      check("the effect state read after the cancel is the committed close (cancelled, no late effects)",
        dataOf(status)?.state === "cancelled" && dataOf(status)?.noLateEffects === true, status);
      const retry = await placement(nc, RECONCILER, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId, fenceId });
      check("a later retry of the same close is clean", dataOf(retry)?.state === "cancelled", retry);
    } finally { lease?.release(); watch.stop(); await nc.close().catch(() => {}); }
  }

  console.log("4. unrelated-seat progress (one caller's close stalled in flight; another caller's close completes)");
  {
    const stalledNc = await reconcilerConnection(RECONCILER);
    const otherNc = await reconcilerConnection(RECONCILER_2);
    const stalledEffect = randomUUID(), otherEffect = randomUUID();
    let lease: HeldLock | undefined = await holdEffect(stalledEffect);
    try {
      const { promise: sentA, resolve: markSentA } = Promise.withResolvers<void>();
      let stalledDone = false;
      const stalled = placement(stalledNc, RECONCILER, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId: stalledEffect, fenceId: randomUUID() },
        { deadlineMs: 40_000, onCommandPublished: markSentA }).finally(() => { stalledDone = true; });
      await within(sentA, 15_000, "the stalled close's publish");
      const other = await placement(otherNc, RECONCILER_2, EP_CMD_CLOSE_ENROLLMENT_EFFECT, { effectId: otherEffect, fenceId: randomUUID() });
      check("a distinct caller's close completes while the first close is stalled in flight",
        dataOf(other)?.state === "cancelled" && !stalledDone && !closedOnDisk(stalledEffect), { other, stalledDone });
      lease.release(); lease = undefined;
      const done = await stalled;
      check("the stalled close completes once released", dataOf(done)?.state === "cancelled", done);
    } finally {
      lease?.release();
      await stalledNc.close().catch(() => {});
      await otherNc.close().catch(() => {});
    }
  }

  console.log(`\nPLACEMENT WIRE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await wide?.close().catch(() => {});
  srv.kill("SIGTERM"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(process.exitCode ?? 0);
