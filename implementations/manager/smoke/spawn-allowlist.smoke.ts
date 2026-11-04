/**
 * Spawn allowlist smoke: `--spawn-allowlist` admission and `allowlist-set`'s wait for in-flight
 * launches. Broker-free: it drives the real spawn, crash-recovery and resume paths against a fake
 * runtime and an `ep` stub (the start-overrides harness), pausing a launch at named seams.
 *
 * The delegated arm needs a host enrollment, an auth provider and a bearer exchange. This smoke
 * stubs those three instance seams and keeps the real re-check and `spawnDelegated` call.
 *
 * Run: pnpm smoke:spawn-allowlist
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { DEV_OWNER, mintLifecycleUid, newIdentity, principalKey, registry, type AgentHandle, type AttachSession, type Connector, type ControlReply, type LaunchSpec, type RuntimeReference } from "@cotal-ai/core";
import { Manager, type ManagerResumeAgent } from "../src/manager.js";

const { check, finish } = createSuite();

interface Seat {
  handle: AgentHandle;
  exit: () => void;
  stopped: () => boolean;
}

/** A fake seat. `holdExit` keeps a stopped seat alive until `exit()` runs. */
function makeSeat(name: string, opts: { holdExit?: boolean; reference?: RuntimeReference } = {}): Seat {
  let exited = false;
  let stopped = false;
  const exitFns = new Set<() => void>();
  // lib is ES2023, so Promise.withResolvers is not typed here.
  let resolveExit = (): void => {};
  const exitP = new Promise<void>((resolve) => { resolveExit = resolve; });
  const exit = (): void => {
    if (exited) return;
    exited = true;
    resolveExit();
    for (const fn of [...exitFns]) fn();
  };
  const session: AttachSession = {
    cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {},
    onExit: (fn) => { exitFns.add(fn); return () => { exitFns.delete(fn); }; },
    write: () => {}, resize: () => {},
  };
  const handle: AgentHandle = {
    name, kind: "pty", ...(opts.reference ? { reference: opts.reference } : {}),
    status: () => (exited ? "exited" : "running"),
    stop: () => { stopped = true; if (!opts.holdExit) exit(); },
    interrupt: () => {},
    attach: () => session,
    waitForExit: () => exitP,
  };
  return { handle, exit, stopped: () => stopped };
}

/** The private members this smoke drives. */
interface ManagerView {
  runtime: object;
  ep: object;
  userMode: boolean;
  remoteAuthority: object | undefined;
  readinessTimeoutMs: number;
  agents: Map<string, { name: string; id: string; lifecycleUid: string; userOwner?: string; handle: AgentHandle; restart?: { armed: boolean } }>;
  spawnCustodied: (...args: unknown[]) => Promise<AgentHandle>;
  opAllowlistSet(args: Record<string, unknown>): Promise<ControlReply>;
  opStop(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply>;
  admitLaunch(name: string): { ok: false; error: string } | { ok: true; token: unknown };
  trackDeprovision(a: object, context: string, token: unknown): void;
  deprovision: (a: object) => Promise<void>;
  resumePreservedAgent(entry: ManagerResumeAgent, preflightOnly?: boolean): Promise<ControlReply>;
  provisionUserAgent: (...args: unknown[]) => Promise<unknown>;
  composeManagedHandoff: (...args: unknown[]) => unknown;
  delegatedMeshRecord: () => unknown;
}
const view = (m: Manager): ManagerView => m as unknown as ManagerView;

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
function gate(): { p: Promise<void>; open: () => void } {
  let open = (): void => {};
  const p = new Promise<void>((resolve) => { open = resolve; });
  return { p, open };
}
function watch(p: Promise<unknown>): () => boolean {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  return () => done;
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-spawn-allowlist-"));
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
for (const n of ["listed", "stranger", "reviewer", "early", "paused", "failing", "rollback1", "medic", "medic2", "rescue", "refused", "mismatch", "deleg1", "deleg2"])
  writeFileSync(join(agentsDir, `${n}.md`), `---\nname: ${n}\nsubscribe: []\n---\n`);

const smokeConnector: Connector = {
  kind: "connector", name: "smoke-allow", requires: ["node"],
  buildLaunch: () => ({ command: "true", args: [], env: {} }),
};
registry.register(smokeConnector);

/** One manager with a recording fake runtime and an ep stub whose roster shows every unhidden row. */
function makeManager(spawnAllowlist?: string) {
  const mgr = new Manager({ space: "smoke", servers: undefined, runtime: "pty", workspaceRoot, ...(spawnAllowlist ? { spawnAllowlist } : {}) });
  const M = view(mgr);
  const spawned: string[] = [];
  const seats = new Map<string, Seat>();
  const hidden = new Set<string>();
  let nextSeat: ((name: string) => Seat) | undefined;
  M.runtime = {
    kind: "pty",
    spawn: (name: string, _spec: LaunchSpec) => {
      spawned.push(name);
      const seat = nextSeat ? nextSeat(name) : makeSeat(name);
      nextSeat = undefined;
      seats.set(name, seat);
      return seat.handle;
    },
  };
  const presence = new Set<() => void>();
  M.ep = {
    ref: () => ({ id: "smoke-mgr" }),
    on: (_event: string, fn: () => void) => { presence.add(fn); },
    off: (_event: string, fn: () => void) => { presence.delete(fn); },
    waitForPresenceSnapshot: async () => {},
    getRoster: () => [...M.agents.values()].filter((a) => !hidden.has(a.name)).map((a) => ({
      card: { id: a.userOwner ? a.id : principalKey(DEV_OWNER, a.id).key, name: a.name },
      status: "idle", lifecycleUid: a.lifecycleUid, ts: Date.now(),
    })),
  };
  M.readinessTimeoutMs = 3000;
  const setNext = (fn: (name: string) => Seat) => { nextSeat = fn; };
  const show = (name: string) => { hidden.delete(name); for (const fn of [...presence]) fn(); };
  return { mgr, M, spawned, seats, hidden, setNext, show };
}

const allowPath = join(workspaceRoot, "allowlist.json");
writeFileSync(allowPath, JSON.stringify(["listed", "reviewer", "early", "paused", "failing", "rollback1", "medic", "medic2", "rescue", "mismatch"]));
const { mgr, M, spawned, seats, hidden, setNext, show } = makeManager(allowPath);
const refusal = (name: string, path = allowPath) => `spawn refused: "${name}" is not in the spawn allowlist ${path}`;
const stop = (name: string) => M.opStop({ name, graceful: false }, "smoke", true);
let allowed = ["listed", "reviewer", "early", "paused", "failing", "rollback1", "medic", "medic2", "rescue", "mismatch"];
const setList = (names: string[]) => { allowed = names; return M.opAllowlistSet({ names }); };
const without = (name: string) => setList(allowed.filter((n) => n !== name));

// ── Admission ─────────────────────────────────────────────────────────────────────
{
  let accepted = false;
  const reply = await mgr.startAgent({ name: "stranger", agent: "smoke-allow", events: false }, undefined, { onAccepted: () => { accepted = true; } });
  check("an unlisted name is refused before mint", reply.ok === false && reply.error === refusal("stranger") && !accepted && !spawned.includes("stranger"), { reply, accepted, spawned });
}
{
  const listed = await mgr.startAgent({ name: "listed", agent: "smoke-allow", events: false });
  check("a listed name spawns", listed.ok === true && M.agents.has("listed") && spawned.includes("listed"), listed);
  await stop("listed");
}
{
  const first = await mgr.startAgent({ name: "reviewer", agent: "smoke-allow", events: false });
  const second = await mgr.startAgent({ name: "reviewer", agent: "smoke-allow", events: false });
  check("a suffixed name from a listed base is refused",
    first.ok === true && second.ok === false && /^spawn refused: "reviewer_\d+" is not in the spawn allowlist /.test(second.error ?? "") && spawned.filter((n) => n.startsWith("reviewer")).length === 1,
    { first, second, spawned });
  await stop("reviewer");
}
{
  const missing = makeManager(join(workspaceRoot, "no-such-allowlist.json"));
  const reply = await missing.mgr.startAgent({ name: "listed", agent: "smoke-allow", events: false });
  check("an unreadable allowlist refuses every name",
    reply.ok === false && reply.error === refusal("listed", join(workspaceRoot, "no-such-allowlist.json")) && missing.spawned.length === 0, reply);
}
{
  const open = makeManager();
  const reply = await open.mgr.startAgent({ name: "stranger", agent: "smoke-allow", events: false });
  check("no option admits every name", reply.ok === true && open.spawned.includes("stranger"), reply);
  await view(open.mgr).opStop({ name: "stranger", graceful: false }, "smoke", true);
}

// ── allowlist-set ─────────────────────────────────────────────────────────────────
{
  const reply = await setList([...allowed, "extra"]);
  const onDisk: unknown = JSON.parse(readFileSync(allowPath, "utf8"));
  check("allowlist-set rewrites the allowlist file", reply.ok === true && Array.isArray(onDisk) && onDisk.includes("extra"), { reply, onDisk });
  await without("extra");
}

// ── Removed during enrollment: refused before the runtime call (custodied) ─────────────
{
  const g = gate();
  const pending = mgr.startAgent({ name: "early", agent: "smoke-allow", events: false }, undefined, { onReadinessWindow: () => g.p });
  await tick();
  const swap = without("early");
  const swapDone = watch(swap);
  g.open();
  const reply = await pending;
  await swap;
  check("a launch whose name is removed during enrollment fails before the runtime call (custodied)",
    reply.ok === false && reply.error === refusal("early") && !spawned.includes("early") && swapDone(), { reply, spawned });
}

// ── Paused between Runtime.spawn and agents.set ─────────────────────────────────────
const realSpawnCustodied = M.spawnCustodied;
{
  const g = gate();
  M.spawnCustodied = async (...args) => { const h = await realSpawnCustodied.apply(mgr, args); await g.p; return h; };
  const pending = mgr.startAgent({ name: "paused", agent: "smoke-allow", events: false });
  await tick();
  const swap = without("paused");
  const swapDone = watch(swap);
  await tick();
  const waitedWhilePaused = !swapDone() && spawned.includes("paused") && !M.agents.has("paused");
  g.open();
  await swap;
  const installed = M.agents.has("paused");
  const stopped = await stop("paused");
  await pending;
  M.spawnCustodied = realSpawnCustodied;
  check("allowlist-set waits for a launch paused between Runtime.spawn and agents.set, and stop then finds it",
    waitedWhilePaused && installed && stopped.ok === true, { waitedWhilePaused, installed, stopped });
}

// ── A failed launch's rollback ──────────────────────────────────────────────────────
{
  // Open mesh: nothing was provisioned, so the attempt's own stopped process is what must exit.
  // onLaunched throwing is the documented abort with the seat already running.
  const g = gate();
  setNext((name) => makeSeat(name, { holdExit: true }));
  M.spawnCustodied = async (...args) => { const h = await realSpawnCustodied.apply(mgr, args); await g.p; return h; };
  const pending = mgr.startAgent({ name: "failing", agent: "smoke-allow", events: false }, undefined, { onLaunched: () => { throw new Error("smoke: activation refused"); } });
  await tick();
  const swap = without("failing");
  const swapDone = watch(swap);
  g.open();
  const reply = await pending;
  await tick();
  const seat = seats.get("failing");
  const heldUntilExit = !swapDone() && seat?.stopped() === true;
  seat?.exit();
  await swap;
  M.spawnCustodied = realSpawnCustodied;
  check("allowlist-set waits for a failed launch's rollback to settle (uninstalled process exits)",
    reply.ok === false && heldUntilExit, { reply, heldUntilExit });
}
{
  // Auth mesh rollback: the token rides trackDeprovision and settles after the deprovision.
  const g = gate();
  const admission = M.admitLaunch("rollback1");
  M.deprovision = () => g.p;
  if (admission.ok) M.trackDeprovision({ name: "rollback1", id: "smoke", lifecycleUid: mintLifecycleUid() }, "(smoke)", admission.token);
  const swap = without("rollback1");
  const swapDone = watch(swap);
  await tick();
  const waited = !swapDone();
  g.open();
  await swap;
  Reflect.deleteProperty(M, "deprovision");
  check("allowlist-set waits for a failed launch's rollback to settle (trackDeprovision)", admission.ok && waited, { admission, waited });
}

// ── Crash recovery ──────────────────────────────────────────────────────────────────
{
  const spawn = await mgr.startAgent({ name: "medic", agent: "smoke-allow", events: false, supervise: { restarts: 3, windowMs: 60_000 } });
  const before = M.agents.get("medic");
  const first = seats.get("medic");
  const g = gate();
  M.spawnCustodied = async (...args) => { const h = await realSpawnCustodied.apply(mgr, args); await g.p; return h; };
  first?.exit();
  await tick(60);
  const respawning = spawned.filter((n) => n === "medic").length === 2;
  const swap = without("medic");
  const swapDone = watch(swap);
  await tick();
  const waited = !swapDone();
  g.open();
  await swap;
  const replacement = seats.get("medic");
  const installed = M.agents.get("medic") === before && before?.handle === replacement?.handle && replacement !== first;
  M.spawnCustodied = realSpawnCustodied;
  check("allowlist-set waits for a crash-recovery replacement to be installed",
    spawn.ok === true && before?.restart?.armed === true && respawning && waited && installed, { spawn, respawning, waited, installed });
  await stop("medic");
}
{
  const spawn = await mgr.startAgent({ name: "medic2", agent: "smoke-allow", events: false, supervise: { restarts: 3, windowMs: 60_000 } });
  await without("medic2");
  const seat = seats.get("medic2");
  const stillRunning = M.agents.has("medic2") && seat?.stopped() === false;
  seat?.exit();
  await tick(60);
  check("crash recovery of a delisted name retires it",
    spawn.ok === true && stillRunning && !M.agents.has("medic2") && spawned.filter((n) => n === "medic2").length === 1,
    { spawn, stillRunning, managed: M.agents.has("medic2"), spawned });
}

// ── Resume ──────────────────────────────────────────────────────────────────────────
const resumeEntry = (name: string): ManagerResumeAgent => {
  const configPath = join(agentsDir, `${name}.md`);
  return {
    space: "smoke", name,
    identity: { mode: "open", id: newIdentity().id, lifecycleUid: mintLifecycleUid() },
    launch: {
      connector: "smoke-allow", runtime: "pty", cwd: workspaceRoot, events: false, allowSubscribe: [],
      source: { kind: "persona", ref: name, configPath, configSha256: createHash("sha256").update(readFileSync(configPath)).digest("hex") },
    },
    dependencies: [configPath], spawner: "smoke", startedAt: new Date().toISOString(),
  };
};
{
  const reply = await M.resumePreservedAgent(resumeEntry("refused"));
  check("resume of a delisted name is refused", reply.ok === false && reply.error === refusal("refused") && !spawned.includes("refused"), reply);
  const preflight = await M.resumePreservedAgent(resumeEntry("refused"), true);
  check("resume preflight of a delisted name is refused", preflight.ok === false && preflight.error === refusal("refused"), preflight);
}
{
  // The resumed seat stays out of the roster, so resumePreservedAgent is still waiting on readiness
  // when its launch installs the row.
  hidden.add("rescue");
  const g = gate();
  M.spawnCustodied = async (...args) => { const h = await realSpawnCustodied.apply(mgr, args); await g.p; return h; };
  const pending = M.resumePreservedAgent(resumeEntry("rescue"));
  const resumeDone = watch(pending);
  await tick();
  const swap = without("rescue");
  const swapDone = watch(swap);
  await tick();
  const waited = !swapDone() && spawned.includes("rescue");
  g.open();
  await swap;
  const settledBeforeResume = !resumeDone() && M.agents.has("rescue");
  show("rescue");
  const reply = await pending;
  M.spawnCustodied = realSpawnCustodied;
  check("allowlist-set waits for launchPreparedResume, not resumePreservedAgent's finally",
    waited && settledBeforeResume && reply.ok === true, { waited, settledBeforeResume, reply });
  await stop("rescue");
}
{
  // A custodial runtime that spawns under another reference than it reserved, and cannot prove it
  // gone: the resume fails, and the attempt holds its token until that process exits.
  const plain = M.runtime;
  let seat: Seat | undefined;
  M.runtime = {
    kind: "pty",
    reserve: (): RuntimeReference => ({ kind: "pty", id: "reserved" }),
    reap: async () => ({ outcome: "retained", reason: "unprovable", detail: "smoke" }),
    spawn: (name: string) => {
      spawned.push(name);
      seat = makeSeat(name, { holdExit: true, reference: { kind: "pty", id: "other" } });
      return seat.handle;
    },
  };
  const reply = await M.resumePreservedAgent(resumeEntry("mismatch"));
  const swap = without("mismatch");
  const swapDone = watch(swap);
  await tick();
  const held = !swapDone();
  seat?.exit();
  await swap;
  M.runtime = plain;
  check("a refused resume spawn holds its token until the spawned process exits",
    reply.ok === false && /reserved custody pty:reserved/.test(reply.error ?? "") && held, { reply, held });
}

// ── Delegated ───────────────────────────────────────────────────────────────────────
{
  writeFileSync(join(workspaceRoot, "allow-delegated.json"), JSON.stringify(["deleg1", "deleg2"]));
  const D = makeManager(join(workspaceRoot, "allow-delegated.json"));
  const handedOff: string[] = [];
  D.M.runtime = {
    kind: "smoke-delegated",
    spawn: () => { throw new Error("a delegated runtime gets no local launch"); },
    spawnDelegated: (launch: { persona: string }) => {
      const name = /name: (\w+)/.exec(launch.persona)?.[1] ?? "?";
      handedOff.push(name);
      return makeSeat(name).handle;
    },
  };
  // Seams: the host enrollment, the registry record and the handoff it composes, and the rollback.
  D.M.userMode = true;
  D.M.remoteAuthority = { enrollManagedAgent: async () => { throw new Error("stubbed"); } };
  D.M.delegatedMeshRecord = () => ({});
  D.M.composeManagedHandoff = () => ({});
  D.M.deprovision = async () => {};
  D.M.provisionUserAgent = async (name: unknown) => ({
    owner: DEV_OWNER, lifecycleUid: mintLifecycleUid(),
    files: { actorToken: join(workspaceRoot, `${String(name)}.token`), sentinelCreds: join(workspaceRoot, `${String(name)}.creds`), health: join(workspaceRoot, `${String(name)}.health`) },
    launch: { owner: DEV_OWNER, actor: String(name), sentinelCredsPath: "", bearerCmd: [] },
    enrolled: { material: {}, actorToken: "" },
  });
  const listed = await D.mgr.startAgent({ name: "deleg1", agent: "smoke-allow", events: false });
  const g = gate();
  const pending = D.mgr.startAgent({ name: "deleg2", agent: "smoke-allow", events: false }, undefined, { onReadinessWindow: () => g.p });
  await tick();
  const swap = view(D.mgr).opAllowlistSet({ names: ["deleg1"] });
  g.open();
  const reply = await pending;
  await swap;
  check("a launch whose name is removed during enrollment fails before the runtime call (delegated)",
    listed.ok === true && handedOff.includes("deleg1") && reply.ok === false && reply.error === refusal("deleg2", join(workspaceRoot, "allow-delegated.json")) && !handedOff.includes("deleg2"),
    { listed, reply, handedOff });
}

console.log("SPAWN-ALLOWLIST SMOKE COMPLETE");
finish();
process.exit(process.exitCode ?? 0);
