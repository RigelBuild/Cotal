/**
 * A manager that dies INSIDE the spawn window leaves an addressable seat. The window is between
 * the launch (the seat's custodian and child now exist, and its custody record is on disk) and the
 * slot activation CAS, and it is the one case the sibling `orphan-seat-reap` suite cannot see:
 * that suite's manager completes its spawn, so its activation records the custody reference on the
 * way past.
 *
 * Before the reservation the reference was minted inside `runtime.spawn`, so nothing durable named
 * the seat until the CAS. A manager killed in between left a slot at `phase=provisioning` with no
 * runtime field, the successor's terminal had nothing to reap, and it retired the lifecycle and
 * freed the alias over a running process. The reference is now reserved before the launch and
 * rides the slot's first durable row, so the successor can still address the seat.
 *
 * Split from `orphan-seat-reap` rather than added to it: both scenarios wait out a manager
 * liveness lease, and one command carrying both crossed `mutation-proof`'s 15-minute timeout,
 * which reports a SIGKILL with no exit status and refuses to grade rather than failing loudly.
 *
 * Run: pnpm smoke:orphan-seat-spawn-window
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  console.log(`ORPHAN-SEAT SPAWN WINDOW COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
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

const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `spawnwin-${randomUUID().slice(0, 8)}`; const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws"); const seatRoot = makeSeatRoot("seats-"); mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth); for (const alias of ["hangworker", "lateworker"]) writeFileSync(join(root, ".cotal", "agents", `${alias}.md`), `---\nname: ${alias}\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n`); writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir); let daemon: CotalEndpoint | undefined; const managers: ChildProcess[] = []; const seatProcs: Array<Owned | undefined> = [];
type Ready = { managerPid: number; managerInstanceId: string; seatPid: number; reference: { kind: string; id: string }; actor: string; lifecycleUid: string };
async function startManager(tag: string, spawnSeat: boolean, opts: { hangMarker?: string; alias?: string; seamHold?: string } = {}): Promise<{ child: ChildProcess; ready?: Ready; stdout: () => string; stderr: () => string }> {
  // `node --import tsx` keeps the manager in THIS ChildProcess, so the suite kills it by handle.
  const child = spawn(process.execPath, ["--import", "tsx", host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_SPAWN: spawnSeat ? "1" : "0", REPRO_ALIAS: opts.alias ?? "hangworker", ...(opts.hangMarker ? { REPRO_HANG_AFTER_SPAWN: "1", REPRO_MARKER: opts.hangMarker } : {}), ...(opts.seamHold ? { REPRO_SEAM_HOLD: opts.seamHold } : {}), COTAL_SEAT_ROOT: seatRoot, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, stdio: ["ignore", "pipe", "pipe"] }); managers.push(child); let out = "", err = ""; child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b)); const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // The hang-window host never reaches REPRO_READY: it freezes inside spawn, so the marker it
    // wrote from there is this manager's readiness.
    if (opts.hangMarker && existsSync(opts.hangMarker)) return { child, stdout: () => out, stderr: () => err };
    const readyLine = out.split("\n").find((x) => x.startsWith("REPRO_READY "));
    if (readyLine) { const ready = JSON.parse(readyLine.slice("REPRO_READY ".length)) as Ready; return { child, ready, stdout: () => out, stderr: () => err }; }
    const spawnLine = out.split("\n").find((x) => x.startsWith("REPRO_SPAWN "));
    if (spawnLine) throw new Error(`${tag} spawn refused: ${spawnLine}\n${err}`);
    if ((!spawnSeat || opts.seamHold) && out.includes("REPRO_MANAGER ")) return { child, stdout: () => out, stderr: () => err };
    if (child.exitCode !== null) throw new Error(`${tag} manager exited ${child.exitCode}: ${err}`);
    await wait(100);
  }
  throw new Error(`${tag} manager readiness timeout: ${err}`);
}
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50); await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const did = newIdentity(); daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, did, "delivery"), card: { id: did.id, name: "delivery", role: "delivery", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false }); daemon.on("error", () => {}); await daemon.start(); await daemon.startPlane3(async () => undefined, { evictPrincipal: async (principal) => evictDeniedPrincipalWithCreds({ servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal, options: { maxVerifyRounds: 12 } }), reloadStoreIdentity: () => ({ kind: "fs", root: resolve(root) }) });
  const marker = join(dir, "hang.json");
  const hung = await startManager("hang-window", true, { hangMarker: marker });
  const spawned = JSON.parse(readFileSync(marker, "utf8")) as { managerPid: number; seatPid: number; reference: { kind: string; id: string } };
  const hungRecord = readRecord(recordPath(seatRoot, spawned.reference.id));
  seatProcs.push(owned(hungRecord.custodianPid, hungRecord.custodianStart), owned(hungRecord.childPid, hungRecord.childStart));
  check("instrument: the frozen manager launched a real seat and never activated its slot", live(hungRecord.childPid) && live(hungRecord.custodianPid) && !hung.stdout().includes("REPRO_READY "), { spawned, state: { child: state(hungRecord.childPid), custodian: state(hungRecord.custodianPid) } });
  await killChild(hung.child);
  await wait(1_000);
  check("instrument: killing it there leaves the seat live with no activated slot", live(hungRecord.childPid) && live(hungRecord.custodianPid), { child: state(hungRecord.childPid), custodian: state(hungRecord.custodianPid) });
  await wait(20_000);
  const third = await startManager("hang-successor", false);
  const sawProvisioning = await until(() => /static reconcile terminal alias=hangworker phase=provisioning/.test(third.stderr()), 60_000);
  check("the successor terminalizes that slot from phase=provisioning", sawProvisioning, third.stderr().split("\n").filter((l) => l.includes("static reconcile terminal")).join("\n"));
  // Without contained (cgroup) custody the reap cannot prove the seat gone, so the successor
  // addresses it by the reserved reference and RETAINS the lifecycle instead of retiring it.
  const hangRetained = await until(() => new RegExp(`! static retirement retained alias=hangworker uid=\\S+ reason=unprovable disposition=refused: runtime "pty" retained pty:${spawned.reference.id} \\(unprovable\\)`).test(third.stderr()), 60_000);
  check("a seat whose spawn never reached the slot activation is still addressed by its reserved reference, and retained", hangRetained && !/static retirement hangworker: orphan seat process/.test(third.stderr()), { stderr: third.stderr().split("\n").filter((l) => l.includes("static retirement")).join("\n") });
  check("that lifecycle is NOT retired over a seat it cannot prove gone", await until(() => /static reconcile completed: 1 attempted, 0 succeeded, 1 failed; failed=hangworker/.test(third.stderr()), 30_000), third.stderr().split("\n").filter((l) => /static reconcile completed/.test(l)).join("\n"));
  await killChild(third.child);
  await wait(20_000); // the killed successor's liveness lease must lapse before the instance starts again

  // ── Late readiness: the custodian is held before it writes its record, past the launcher's
  // ten-second bound. The spawn fails, its rollback reaps the reserved reference (the record is not
  // there yet, or it cannot be proved gone) and the lifecycle is retained. Once the custodian does
  // come up, the next reconcile reaps a live record and is STILL retained, never retired over it.
  // The hold is released as soon as the spawn fails: the custodian abandons a hold after 15s.
  const holdDir = join(dir, "late-hold"); mkdirSync(holdDir);
  const late = await startManager("late-readiness", true, { alias: "lateworker", seamHold: holdDir });
  type LateStatus = { failures: Array<{ alias: string; lifecycleUid: string; disposition: string; retainedReason?: string; remedy?: string }>; retainedCustody: number };
  const lateStatus = (): LateStatus | undefined => {
    const line = late.stdout().split("\n").filter((l) => l.startsWith("REPRO_STATUS ")).pop();
    return line === undefined ? undefined : JSON.parse(line.slice("REPRO_STATUS ".length)) as LateStatus;
  };
  const lateItem = () => lateStatus()?.failures.find((f) => f.alias === "lateworker");
  const spawnFailed = await until(() => late.stdout().includes("REPRO_SPAWN "), 60_000);
  writeFileSync(join(holdDir, "release"), "go\n");
  const lateReply = late.stdout().split("\n").find((l) => l.startsWith("REPRO_SPAWN "))?.slice("REPRO_SPAWN ".length) ?? "";
  const firstRetained = await until(() => lateItem()?.disposition === "refused" && lateItem()?.retainedReason !== undefined, 30_000);
  // The launcher creates the reserved id's directory before the custodian runs; it is the one
  // seat id under the root that is not the hang-window seat.
  const lateId = readdirSync(seatRoot).find((id) => /^[0-9a-f]{32}$/.test(id) && id !== spawned.reference.id) ?? "";
  check("late readiness: the spawn fails at the launcher bound, its rollback addresses the reserved reference, and the status is retained (refused, release remedy)",
    spawnFailed && /did not write a seat record/.test(lateReply) && firstRetained && lateId !== "" && new RegExp(`retained alias=lateworker [^\\n]*pty:${lateId}`).test(late.stderr()) && /release-seat/.test(lateItem()?.remedy ?? ""),
    { lateReply, lateId, item: lateItem(), lines: late.stderr().split("\n").filter((l) => l.includes("lateworker")).join("\n") });
  const cameUp = await until(() => lateId !== "" && existsSync(recordPath(seatRoot, lateId)), 15_000);
  if (cameUp) { const r = readRecord(recordPath(seatRoot, lateId)); seatProcs.push(owned(r.custodianPid, r.custodianStart), owned(r.childPid, r.childStart)); }
  writeFileSync(join(holdDir, "reconcile"), "go\n");
  const reconciled = await until(() => late.stdout().includes("REPRO_RECONCILED"), 60_000);
  await wait(500); // one more status line after the sweep settles
  const lateCreds = agentLifecycleSecretFilePaths(root, space, "lateworker", lateItem()?.lifecycleUid ?? "").creds;
  check("late readiness: after the custodian becomes ready, the next reconcile is still retained (unprovable, refused), and the creds file remains",
    cameUp && reconciled && lateItem()?.disposition === "refused" && lateItem()?.retainedReason === "unprovable" && (lateStatus()?.retainedCustody ?? 0) >= 1 && lateCreds !== undefined && existsSync(lateCreds),
    { cameUp, reconciled, item: lateItem(), lines: late.stderr().split("\n").filter((l) => l.includes("lateworker")).join("\n") });

  const EXPECTED = 7;
  if (pass + fail !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail}; a cell was added or silently skipped`);
  console.log(`\nORPHAN-SEAT SPAWN WINDOW SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
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
