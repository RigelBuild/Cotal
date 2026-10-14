/**
 * A crashed manager's custodied seat is addressed by its successor, and the successor never retires
 * the lifecycle over a seat it cannot prove gone. Real manager processes on the production
 * custodial pty runtime, a real custodian + child pair, an ephemeral auth broker.
 *
 * The slot row records the seat's custody reference, and the successor's terminal reaps by that
 * reference after it verify-evicts the orphan's broker rails. Without contained (cgroup) custody
 * nothing on this host proves the seat's processes gone, so the reap returns `unprovable` and the
 * terminal RETAINS: the slot stays terminalizing, the creds file stays, and the sweep reports the
 * alias failed with the release remedy. Linux only, like the custodian.
 *
 * Run: pnpm smoke:orphan-seat-reap
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, createSpaceAuth, evictDeniedPrincipalWithCreds, isReachable, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { readRecord, recordPath } from "@cotal-ai/seat";
import { agentLifecycleSecretFilePaths, authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, makeSeatRoot } from "@cotal-ai/smoke-kit";
import { killChild, killOwned, owned, type Owned } from "./_owned-kill.js";

if (process.platform !== "linux") {
  console.log(`ORPHAN-SEAT REAP COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const freePort = (): Promise<number> => new Promise((res, rej) => { const s = createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (read()) return true; await wait(100); }
  return read();
};
const state = (pid: number): string => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "unknown";
  } catch { return "gone"; }
};
const live = (pid: number): boolean => state(pid) !== "gone" && state(pid) !== "Z";
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_orphan-reap-host.ts");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `reap1100-${randomUUID().slice(0, 8)}`; const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); const seatRoot = makeSeatRoot("seats-"); mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth); writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n"); writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir); let daemon: CotalEndpoint | undefined; const managers: ChildProcess[] = []; const seatProcs: Array<Owned | undefined> = [];
type Ready = { managerPid: number; managerInstanceId: string; seatPid: number; reference: { kind: string; id: string }; actor: string; lifecycleUid: string };
async function startManager(tag: string, spawnSeat: boolean, opts: { alias?: string; hangMarker?: string } = {}): Promise<{ child: ChildProcess; ready?: Ready; stdout: () => string; stderr: () => string }> {
  // `node --import tsx` keeps the manager in THIS ChildProcess, so the suite kills it by handle.
  const child = spawn(process.execPath, ["--import", "tsx", host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_SPAWN: spawnSeat ? "1" : "0", REPRO_ALIAS: opts.alias ?? "worker", ...(opts.hangMarker ? { REPRO_HANG_AFTER_SPAWN: "1", REPRO_MARKER: opts.hangMarker } : {}), COTAL_SEAT_ROOT: seatRoot, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, stdio: ["ignore", "pipe", "pipe"] }); managers.push(child); let out = "", err = ""; child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b)); const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // The hang-window host never reaches REPRO_READY: it freezes inside spawn, so the marker it
    // wrote from there is this manager's readiness.
    if (opts.hangMarker && existsSync(opts.hangMarker)) return { child, stdout: () => out, stderr: () => err };
    const readyLine = out.split("\n").find((x) => x.startsWith("REPRO_READY "));
    if (readyLine) { const ready = JSON.parse(readyLine.slice("REPRO_READY ".length)) as Ready; return { child, ready, stdout: () => out, stderr: () => err }; }
    const spawnLine = out.split("\n").find((x) => x.startsWith("REPRO_SPAWN "));
    if (spawnLine) throw new Error(`${tag} spawn refused: ${spawnLine}\n${err}`);
    if (!spawnSeat && out.includes("REPRO_MANAGER ")) return { child, stdout: () => out, stderr: () => err };
    if (child.exitCode !== null) throw new Error(`${tag} manager exited ${child.exitCode}: ${err}`);
    await wait(100);
  }
  throw new Error(`${tag} manager readiness timeout: ${err}`);
}
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50); await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const did = newIdentity(); daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, did, "delivery"), card: { id: did.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false }); daemon.on("error", () => {}); await daemon.start(); await daemon.startPlane3(async () => undefined, { evictPrincipal: async (principal) => evictDeniedPrincipalWithCreds({ servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal, options: { maxVerifyRounds: 12 } }), reloadStoreIdentity: () => ({ kind: "fs", root: resolve(root) }) });
  const first = await startManager("first", true);
  const ready = first.ready!;
  const record = readRecord(recordPath(seatRoot, ready.reference.id));
  seatProcs.push(owned(record.custodianPid, record.custodianStart), owned(record.childPid, record.childStart));
  check("instrument: the seat is a real custodian + child pair with pinned start identities", ready.reference.kind === "pty" && record.childPid === ready.seatPid && typeof record.custodianStart === "string" && typeof record.childStart === "string", { ready, record });
  await killChild(first.child);
  await wait(1_000);
  check("instrument: manager SIGKILL leaves the custodian and the seat child live", live(record.custodianPid) && live(record.childPid), { custodian: state(record.custodianPid), child: state(record.childPid) });
  // The dead manager's liveness lease must lapse before the same logical instance can start again.
  await wait(20_000);
  const second = await startManager("successor", false);
  const retainedLine = new RegExp(`! static retirement retained alias=worker uid=${ready.lifecycleUid} reason=unprovable disposition=refused: runtime "pty" retained pty:${ready.reference.id} \\(unprovable\\)[^\\n]*NEXT: [^\\n]*release-seat`);
  const retained = await until(() => retainedLine.test(second.stderr()), 60_000);
  check("successor reaps the orphan by the row's reference and RETAINS it (unprovable, refused, release remedy)", retained, second.stderr().split("\n").filter((l) => l.includes("static retirement")).join("\n"));
  check("the successor never reports the seat process gone", !/static retirement worker: orphan seat process/.test(second.stderr()), second.stderr().split("\n").filter((l) => l.includes("orphan seat process")).join("\n"));
  const evictedFirst = second.stderr().indexOf(`verified orphan seat principal gone: local.${ready.actor}`);
  const retainedAt = second.stderr().search(retainedLine);
  check("broker eviction and the retained reap are separate, ordered evidence (rails verified gone, then the process step)", evictedFirst >= 0 && retainedAt > evictedFirst, { evictedFirst, retainedAt });
  const failed = await until(() => /static reconcile completed: 1 attempted, 0 succeeded, 1 failed; failed=worker/.test(second.stderr()), 30_000);
  const creds = agentLifecycleSecretFilePaths(root, space, "worker", ready.lifecycleUid).creds;
  check("the lifecycle is NOT retired: the sweep reports it failed and its creds file remains", failed && creds !== undefined && existsSync(creds), { creds, lines: second.stderr().split("\n").filter((l) => /static (reconcile|retirement)/.test(l)).join("\n") });
  const EXPECTED = 6;
  if (pass + fail !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail}; a cell was added or silently skipped`);
  console.log(`\nORPHAN-SEAT REAP SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} finally {
  for (const child of managers) await killChild(child);
  for (const p of seatProcs) killOwned(p);
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true }); // its own root now: `dir` no longer contains it
  releaseBroker();
}
