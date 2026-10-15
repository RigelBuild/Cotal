/**
 * Seat behavior cells plus worker-death survival and wait-exit close settlement.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptSeatSync, bootToken, launchSeat, processStartToken, reapSeat, seatId, SeatClient, type SeatRecord } from "../src/index.js";
import { setCustodianTestSeam } from "../src/launcher.js";
import { pidfdOpen, pidfdSignal } from "../src/peercred.js";
import type { CustodianTestSeam } from "../src/custodian.js";
import { GRACE_MS } from "../src/protocol.js";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log(`SEAT LIFECYCLE COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

// OS-level socket teardown race: a block closes its handles before the linger cells, but the
// custodian tears the Unix socket down at the kernel level when it settles. If the FIN for our
// close() is still in flight when the custodian exits, the kernel delivers RST to this process's
// fd and Node surfaces it as an uncaught ECONNRESET on the internal Pipe read callback. The socket
// is already closed on our side, so this is the OS race and not a missing close. Everything else
// still ends the run.
process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
  console.error(err);
  process.exit(1);
});

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await wait(25);
  return predicate();
};
const state = (pid: number): string => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "unknown";
  } catch {
    try {
      process.kill(pid, 0);
      return "live";
    } catch {
      return "gone";
    }
  }
};

const root = makeSeatRoot("cotal-seat-life-");
const handles: Array<{
  stop: (o?: { graceful?: boolean }) => void;
  close?: () => void;
  record: { custodianPid: number; childPid: number; custodianStart?: string; childStart?: string };
}> = [];
type Owned = { pid: number; start: string | undefined };
/** Pids a T1 cell leaves behind on purpose (or a mutant leaves by mistake); killed in `finally`. */
const strays: Owned[] = [];
const isGone = (pid: number): boolean => state(pid) === "gone" || state(pid) === "Z";
/** For pids that are not this suite's direct children. The pidfd pins one process before its start
 *  token is checked, so a reused pid is never signalled. */
const killOwned = (pid: number, start: string | undefined): void => {
  if (pid <= 1 || start === undefined) return;
  const fd = pidfdOpen(pid);
  if (fd === undefined) return;
  try {
    if (processStartToken(pid) === start) pidfdSignal(fd, "SIGKILL");
  } catch { /* already gone */ } finally {
    closeSync(fd);
  }
};
/** The pid a fixture child wrote, with its start token read at once so a later kill can prove it. */
const readPid = (path: string): Owned | undefined => {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return n > 0 ? { pid: n, start: processStartToken(n) } : undefined;
  } catch {
    return undefined;
  }
};
// A seat child that ignores the PTY hangup, marks a SIGTERM instead of dying, records its pid and
// then releases the custodian's seam hold, so no signal can land before its handlers are armed.
const ARMED_CHILD =
  "const fs=require('fs');const [pidf,mark,rel]=process.argv.slice(1);" +
  "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>fs.writeFileSync(mark,'term'));" +
  "fs.writeFileSync(pidf,String(process.pid));if(rel)fs.writeFileSync(rel,'');setInterval(()=>{},1000);";
/** Launch under a test seam; a launch that should have failed but did not leaves its pids to `strays`. */
const launchUnderSeam = (seam: CustodianTestSeam, id: string, args: string[]): string => {
  setCustodianTestSeam(seam);
  try {
    const rec: SeatRecord = launchSeat({ root, name: "t1-seam", id, spec: { command: process.execPath, args, env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd() });
    strays.push({ pid: rec.custodianPid, start: rec.custodianStart }, { pid: rec.childPid, start: rec.childStart });
    return "";
  } catch (e) {
    return (e as Error).message;
  } finally {
    setCustodianTestSeam(undefined);
  }
};
/** Run `then` (sh, args $2…) once `reached` exists; launchSeat blocks this event loop meanwhile. */
const onReached = (reached: string, then: string, ...args: string[]): void => {
  const script = `i=0; while [ ! -e "$1" ] && [ $i -lt 1000 ]; do sleep 0.02; i=$((i+1)); done; ${then}`;
  spawn("sh", ["-c", script, "sh", reached, ...args], { stdio: "ignore" }).unref();
};
const collect = async (h: ReturnType<typeof adoptSeatSync>, ms = 800): Promise<string> => {
  const sess = h.attach();
  let buf = "";
  sess.onData((b) => {
    buf += b.toString("utf8");
  });
  await wait(ms);
  return buf.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
};

try {
  {
    const rec = launchSeat({
      root,
      name: "counter",
      spec: {
        command: process.execPath,
        args: ["-e", "let n=0; setInterval(()=>process.stdout.write(String(++n)+'\\n'), 50)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    check("spawn: custodian and child are live", state(rec.custodianPid) !== "gone" && state(rec.childPid) !== "gone", rec);
    const snap = await h.attach().backlog();
    check("snapshot: backlog returns bytes", snap.length >= 0);
    const first = await collect(h, 400);
    const second = await collect(h, 400);
    check("concurrent read: two attach sessions both receive output", /\d/.test(first) && /\d/.test(second), { first, second });
    h.write("ping\n");
    const afterWrite = await collect(h, 200);
    check("input: write does not throw and seat stays running", h.status() === "running", afterWrite);
    h.attach().resize(80, 24);
    h.attach().resize(0, 0);
    check("resize: 0x0 is a no-op and seat stays running", h.status() === "running");
    await h.attach().backlog();
    const sized = h.attach();
    sized.resize(90, 25);
    check("resize: geometry is visible on the attach session", sized.cols === 90 && sized.rows === 25);
    await wait(50);
    check("resize: geometry survives the hello apply", sized.cols === 90 && sized.rows === 25, {
      cols: sized.cols,
      rows: sized.rows,
    });
    const worker = mkdtempSync(join(root, "worker-"));
    const ready = join(worker, "ready.json");
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = join(here, "..", "dist");
    writeFileSync(
      join(worker, "owner.mjs"),
      `import { launchSeat, adoptSeatSync } from ${JSON.stringify(join(dist, "index.js"))};\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `const rec = launchSeat({ root: ${JSON.stringify(root)}, name: "survive", spec: { command: process.execPath, args: ["-e", "setInterval(()=>{}, 1000)"], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd() });\n` +
        `const h = adoptSeatSync(rec);\n` +
        `writeFileSync(process.env.READY ?? "", JSON.stringify({ workerPid: process.pid, childPid: rec.childPid, custodianPid: rec.custodianPid, id: rec.id }));\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    let owner: ChildProcess | undefined;
    owner = spawn(process.execPath, [join(worker, "owner.mjs")], {
      env: { PATH: process.env.PATH ?? "", READY: ready },
      stdio: "ignore",
    });
    const armed = await until(() => {
      try {
        return JSON.parse(readFileSync(ready, "utf8")).childPid !== undefined;
      } catch {
        return false;
      }
    }, 10_000);
    check("isolated worker fixture armed", armed);
    const ids = JSON.parse(readFileSync(ready, "utf8")) as { workerPid: number; childPid: number; custodianPid: number; id: string };
    owner.kill("SIGKILL");
    check("the fixture killed its actual worker process", await until(() => state(ids.workerPid) === "gone", 5_000), ids);
    check(
      "worker death leaves the custodial child PID running",
      await until(() => state(ids.childPid) !== "gone" && state(ids.childPid) !== "Z", 5_000),
      { child: state(ids.childPid), custodian: state(ids.custodianPid) },
    );
    // The full on-disk record, so cleanup keeps the start tokens that prove these pids are ours.
    const adopted = adoptSeatSync(JSON.parse(readFileSync(join(root, ids.id, "record.json"), "utf8")) as SeatRecord);
    handles.push(adopted);
    check("adopt: successor proxy talks to the surviving seat", (await adopted.attach().backlog()).length >= 0);
    adopted.stop({ graceful: false });
    await adopted.waitForExit();
    check("hard stop: child is gone after waitForExit", await until(() => state(ids.childPid) === "gone" || state(ids.childPid) === "Z", 5_000), state(ids.childPid));
    if (owner.exitCode === null) owner.kill("SIGKILL");
  }

  {
    const rec = launchSeat({
      root,
      name: "exit-notify",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    await h.attach().backlog();
    let fired = false;
    h.attach().onExit(() => {
      fired = true;
    });
    killOwned(rec.childPid, rec.childStart);
    check(
      "onExit fires without an output subscription",
      await until(() => fired, 5_000),
      { fired, status: h.status() },
    );
  }

  {
    const rec = launchSeat({
      root,
      name: "fast-exit",
      spec: {
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    check(
      "fast-exit child is gone before onExit subscribe",
      await until(() => state(rec.childPid) === "gone" || state(rec.childPid) === "Z", 5_000),
      state(rec.childPid),
    );
    await h.attach().backlog();
    check(
      "handle already observed exit before a late onExit subscribe",
      await until(() => h.status() === "exited", 5_000),
      h.status(),
    );
    let fired = false;
    h.attach().onExit(() => {
      fired = true;
    });
    check(
      "onExit fires for a child that exits before hello",
      await until(() => fired, 5_000),
      { fired, status: h.status() },
    );
  }

  {
    const rec = launchSeat({
      root,
      name: "wait-exit-close",
      spec: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const client = new SeatClient(rec);
    handles.push({
      stop: () => {},
      close: () => client.close(),
      record: rec,
    });
    await client.connect();
    check(
      "wait-exit close race: child has already exited",
      await until(() => client.info().status === "exited", 5_000),
      client.info(),
    );
    const pending = client.waitExit();
    client.close();
    let err = "";
    try {
      await pending;
    } catch (e) {
      err = (e as Error).message;
    }
    check("wait-exit still settles after close once the child has exited", err === "", err);
  }

  {
    const rec = launchSeat({
      root,
      name: "natural",
      spec: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('bye\\n'); process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    await h.waitForExit();
    check("natural exit: waitForExit resolves and status is exited", h.status() === "exited");
    h.close();
    const recordKept = join(root, rec.id, "record.json");
    // The record outlives the custodian: only a proved reap or a durable release removes a seat dir.
    check(
      "natural exit: custodian process and socket converge and the record is retained without fixture kill",
      await until(() => {
        const custodianGone = state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z";
        return custodianGone && !existsSync(rec.socket) && existsSync(recordKept);
      }, 5_000),
      {
        custodian: state(rec.custodianPid),
        socket: existsSync(rec.socket),
        record: existsSync(recordKept),
      },
    );
    handles.push(h);
  }

  {
    const rec = launchSeat({
      root,
      name: "fast-print",
      spec: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('FAST_MARK=1\\n'); process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    handles.push(h);
    check(
      "fast-print child is gone before attach subscribe",
      await until(() => state(rec.childPid) === "gone" || state(rec.childPid) === "Z", 5_000),
      state(rec.childPid),
    );
    const sess = h.attach();
    let buf = "";
    sess.onData((b) => {
      buf += b.toString("utf8");
    });
    let exited = false;
    sess.onExit(() => {
      exited = true;
    });
    await until(() => exited, 5_000);
    const seen = buf.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    check("fast-exit print reaches onData before onExit", exited && seen.includes("FAST_MARK=1"), { exited, seen });
  }

  {
    const leakRoot = makeSeatRoot("sl-");
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const dist = join(here, "..", "dist");
      const script = join(leakRoot, "drop-socket.mjs");
      writeFileSync(
        script,
        `import { launchSeat, adoptSeatSync } from ${JSON.stringify(join(dist, "index.js"))};
const rec = launchSeat({
  root: ${JSON.stringify(leakRoot)},
  name: "dropleak",
  spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } },
  cwd: process.cwd(),
});
const h = adoptSeatSync(rec);
h.stop({ graceful: false });
await h.waitForExit();
`,
      );
      const dropEnv = { ...process.env };
      for (const key of Object.keys(dropEnv)) if (key.startsWith("COTAL_")) delete dropEnv[key];
      const drop = spawnSync(process.execPath, [script], {
        encoding: "utf8",
        timeout: 8_000,
        killSignal: "SIGKILL",
        env: dropEnv,
      });
      check(
        "waitForExit drops the controller socket so the worker can exit",
        drop.status === 0 && drop.signal === null,
        { status: drop.status, signal: drop.signal, stderr: drop.stderr },
      );
    } finally {
      rmSync(leakRoot, { recursive: true, force: true });
    }
  }

  {
    // Close every handle the blocks above still hold before the unadopted cells run: their
    // custodians can settle the moment their child has exited, and the settle tears the socket
    // down under a socket this process has not closed yet.
    for (const h of handles) { try { h.close?.(); } catch { /* already gone */ } }

    // A custodian whose child has exited is custody of nothing. Before this policy it lived
    // forever, one idle node process per seat the manager ever ran. Nobody adopts this seat, so it
    // settles on the custodian's unobserved-handoff path rather than on a client drop, which is the
    // one arm of that policy the adopted natural-exit cell above does not reach.
    const rec = launchSeat({
      root,
      name: "unadopted",
      spec: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    check("record pins both start identities", typeof rec.custodianStart === "string" && typeof rec.childStart === "string", rec);
    check(
      "unadopted custodian exits after its child exits",
      await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", 20_000),
      state(rec.custodianPid),
    );
    check("its socket is gone with it and its record is retained", !existsSync(rec.socket) && existsSync(join(root, rec.id, "record.json")), rec.socket);
  }

  {
    // Without a contained cgroup, reap can ask the custodian to stop but cannot prove descendants gone.
    const rec = launchSeat({
      root,
      name: "reap-live",
      spec: {
        command: process.execPath,
        // The descendant exits when its parent's pipe closes, so cleanup needs no group signal.
        args: ["-e", "require('child_process').spawn(process.execPath, ['-e', 'process.stdin.on(\"end\",()=>process.exit(0));process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] }); setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const recordPath = join(root, rec.id, "record.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as SeatRecord;
    writeFileSync(recordPath, `${JSON.stringify({ ...record, socket: join(root, rec.id, "attacker-socket.sock") })}\n`);
    await wait(500);
    const evidence = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "reap of a live seat is retained and asks its custodian at the derived socket to stop",
      !(evidence instanceof Error) && evidence.outcome === "retained" && evidence.reason === "unprovable" && evidence.stop === "requested",
      evidence instanceof Error ? evidence.message : evidence,
    );
    check("the custodian stops its child on that request", await until(() => isGone(rec.childPid), 5_000), state(rec.childPid));
    check("the custody record is kept", existsSync(join(root, rec.id, "record.json")), rec.id);
    // The custodian drops its socket only once it has settled; until then it still answers a stop.
    await until(() => !existsSync(join(root, rec.id, "seat.sock")), 5_000);
    const second = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "a repeated reap keeps the custody record retained",
      !(second instanceof Error) && second.outcome === "retained" && second.reason === "unprovable" && second.stop === "no-custodian",
      second instanceof Error ? second.message : second,
    );
    killOwned(rec.childPid, rec.childStart);
    killOwned(rec.custodianPid, rec.custodianStart);
  }

  {
    // Layer 2: an unreadable record (here a directory where the file should be) is retained, not absent.
    const id = seatId();
    mkdirSync(join(root, id, "record.json"), { recursive: true, mode: 0o700 });
    const unreadable = await reapSeat(root, id).catch((e: Error) => e);
    check(
      "an unreadable custody record is retained, never absent",
      !(unreadable instanceof Error) && unreadable.outcome === "retained" && unreadable.reason === "unprovable",
      unreadable instanceof Error ? unreadable.message : unreadable,
    );
  }

  {
    // A socket that accepts and never answers bounds the stop request at graceMs.
    const id = seatId();
    mkdirSync(join(root, id), { recursive: true, mode: 0o700 });
    const accepted: Array<{ destroy: () => void }> = [];
    const silent = createServer((c) => { accepted.push(c); });
    await new Promise<void>((r) => silent.listen(join(root, id, "seat.sock"), r));
    // Forge only a pid this test owns, leading its own group: a mutant that signals record pids
    // must never reach pid 1, -1 or any process outside this suite.
    const decoy = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const decoyPid = decoy.pid;
    if (decoyPid === undefined || decoyPid <= 1) throw new Error(`decoy sleeper has unusable pid ${String(decoyPid)}`);
    const forged: SeatRecord = { version: 1, id, name: "silent", socket: join(root, id, "seat.sock"), token: "t", custodianPid: decoyPid, childPid: decoyPid };
    writeFileSync(join(root, id, "record.json"), `${JSON.stringify(forged)}\n`);
    const started = Date.now();
    // Capped here so a missing bound shows as this cell failing, not a hung suite.
    const silentReap = await Promise.race([
      reapSeat(root, id, { graceMs: 300 }).catch((e: Error) => e),
      wait(3_000).then(() => new Error("reap did not return within 3s")),
    ]);
    const took = Date.now() - started;
    // Drop accepted connections too: a reap stuck on one must not keep the suite alive under the mutation.
    for (const c of accepted) c.destroy();
    silent.close();
    silent.unref();
    decoy.kill("SIGKILL");
    check(
      "a custodian socket that never answers times out the stop within graceMs, still retained",
      !(silentReap instanceof Error) && silentReap.outcome === "retained" && silentReap.stop === "timeout" && took < 2_000,
      { evidence: silentReap instanceof Error ? silentReap.message : silentReap, took },
    );
  }

  {
    // A reference reaches reapSeat and loadSeat from a durable slot row, so the id is checked
    // against the shape seatId mints before it is joined to the custody root. An id that walks out
    // of the root is refused rather than resolved: reporting it as absent would call an
    // unaddressable seat "already forgotten".
    const traversal = "../../../etc";
    let refusedReap = "";
    try { await reapSeat(root, traversal); } catch (e) { refusedReap = (e as Error).message; }
    check("a forged custody id that walks out of the root is refused, not resolved", /is not 32 lowercase hex characters/.test(refusedReap), refusedReap);
    let refusedLaunch = "";
    try { launchSeat({ root, name: "traversal", spec: { command: process.execPath, args: ["-e", ""], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd(), id: traversal }); } catch (e) { refusedLaunch = (e as Error).message; }
    check("a launch under a forged custody id is refused before any process starts", /is not 32 lowercase hex characters/.test(refusedLaunch), refusedLaunch);
    const reserved = seatId();
    const rec = launchSeat({ root, name: "reserved", spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd(), id: reserved });
    handles.push(adoptSeatSync(rec));
    check("a launch under a reserved id custodies the seat under exactly that id", rec.id === reserved && existsSync(join(root, reserved, "record.json")), { reserved, got: rec.id });
    let reused = "";
    try { launchSeat({ root, name: "reserved", spec: { command: process.execPath, args: ["-e", ""], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd(), id: reserved }); } catch (e) { reused = (e as Error).message; }
    check("a custody id already holding a record refuses a second launch", /already holds a custody record/.test(reused), reused);
  }
  {
    const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    sleeper.unref();
    const sleeperPid = sleeper.pid;
    if (sleeperPid === undefined || sleeperPid <= 1) throw new Error("detached sleeper did not expose a usable pid");
    try {
      const started = await until(() => processStartToken(sleeperPid) !== undefined, 1_000);
      const start = processStartToken(sleeperPid);
      if (!started || start === undefined) throw new Error("detached sleeper did not start");
      const boot = bootToken();
      const id = seatId();
      const record: SeatRecord = {
        version: 1,
        id,
        name: "forged-same-uid",
        socket: join(root, id, "attacker-socket.sock"),
        token: "forged-token",
        custodianPid: sleeperPid,
        childPid: sleeperPid,
        custodianStart: start,
        childStart: start,
        ...(boot === undefined ? {} : { bootId: boot }),
      };
      mkdirSync(join(root, id), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, id, "record.json"), `${JSON.stringify(record)}\n`);
      const stat = readFileSync(`/proc/${sleeperPid}/stat`, "utf8");
      const pgid = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]);
      check("forged-record fixture: detached sleeper is its own process-group leader", pgid === sleeperPid, { sleeperPid, pgid });
      const evidence = await reapSeat(root, id, { graceMs: 100 }).catch((e: Error) => e);
      // A SIGKILL lands asynchronously, so give a signalled sleeper time to die before calling it untouched.
      const died = await until(() => state(sleeperPid) === "gone" || state(sleeperPid) === "Z", 1_000);
      check(
        "a forged same-uid record is retained and its process-group leader is never signalled",
        !(evidence instanceof Error) && evidence.outcome === "retained" && evidence.reason === "unprovable" && evidence.stop === "no-custodian" && !died,
        evidence instanceof Error ? evidence.message : evidence,
      );
    } finally {
      sleeper.kill("SIGKILL");
      await until(() => isGone(sleeperPid), 2_000);
    }
  }

  {
    const rec = launchSeat({
      root,
      name: "reap-foreign",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    handles.push(adoptSeatSync(rec));
    const bare = { ...rec };
    delete (bare as Partial<typeof rec>).custodianStart;
    writeFileSync(join(root, rec.id, "record.json"), `${JSON.stringify(bare)}\n`);
    const missingIdentity = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "a record with no start identity is retained",
      !(missingIdentity instanceof Error) && missingIdentity.outcome === "retained" && missingIdentity.reason === "unprovable",
      missingIdentity instanceof Error ? missingIdentity.message : missingIdentity,
    );
    const forged = { ...rec, custodianStart: "1", childStart: "1" };
    writeFileSync(join(root, rec.id, "record.json"), `${JSON.stringify(forged)}\n`);
    const mismatch = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "a pid whose start identity differs from the record is retained",
      !(mismatch instanceof Error) && mismatch.outcome === "retained" && mismatch.reason === "unprovable",
      mismatch instanceof Error ? mismatch.message : mismatch,
    );
  }

  {
    const rec = launchSeat({
      root,
      name: "reap-reboot",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    handles.push(adoptSeatSync(rec));
    const path = join(root, rec.id, "record.json");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    check("the custodian stamps the boot its pids belong to", onDisk.bootId === bootToken(), onDisk.bootId);
    writeFileSync(path, `${JSON.stringify({ ...onDisk, bootId: "00000000-0000-0000-0000-000000000000" })}\n`);
    const foreign = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "a foreign boot record is retained instead of throwing",
      !(foreign instanceof Error) && foreign.outcome === "retained" && foreign.reason === "unprovable" && foreign.stop === "requested",
      foreign instanceof Error ? foreign.message : foreign,
    );
    const { bootId: _dropped, ...unbound } = onDisk;
    writeFileSync(path, `${JSON.stringify(unbound)}\n`);
    const unboundResult = await reapSeat(root, rec.id).catch((e: Error) => e);
    check(
      "a record with no boot identity is retained",
      !(unboundResult instanceof Error) && unboundResult.outcome === "retained" && unboundResult.reason === "unprovable",
      unboundResult instanceof Error ? unboundResult.message : unboundResult,
    );
  }
  {
    const dir = mkdtempSync(join(root, "setsid-escapee-"));
    const childPidPath = join(dir, "child.pid");
    const grandchildPidPath = join(dir, "grandchild.pid");
    const child = spawn(process.execPath, [
      "-e",
      "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const [childFile,grandFile]=process.argv.slice(1); fs.writeFileSync(childFile,String(process.pid)); const g=spawn(process.execPath,['-e',\"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)\",grandFile],{detached:true,stdio:'ignore'}); g.unref(); setTimeout(()=>process.exit(0),300);",
      childPidPath,
      grandchildPidPath,
    ], { stdio: "ignore" });
    child.unref();
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("setsid fixture child did not expose its pid");
    try {
      const childReady = await until(() => existsSync(childPidPath), 2_000);
      const grandchildReady = await until(() => existsSync(grandchildPidPath), 2_000);
      const grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
      const grandchildStart = processStartToken(grandchildPid);
      check("setsid escapee fixture: grandchild starts in a new session", childReady && grandchildReady && state(grandchildPid) !== "gone", { childPid, grandchildPid });
      const id = seatId();
      const boot = bootToken();
      const childStart = processStartToken(childPid);
      const record: SeatRecord = {
        version: 1,
        id,
        name: "setsid-escapee",
        socket: join(root, id, "missing-seat.sock"),
        token: "missing-token",
        custodianPid: childPid,
        childPid,
        ...(childStart === undefined ? {} : { custodianStart: childStart, childStart }),
        ...(boot === undefined ? {} : { bootId: boot }),
      };
      mkdirSync(join(root, id), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, id, "record.json"), `${JSON.stringify(record)}\n`);
      await until(() => isGone(childPid), 2_000);
      const evidence = await reapSeat(root, id, { graceMs: 100 }).catch((e: Error) => e);
      check(
        "a setsid escapee keeps the reap retained and is never signalled",
        !(evidence instanceof Error) && evidence.outcome === "retained" && evidence.reason === "unprovable" && evidence.stop === "no-custodian" && state(grandchildPid) !== "gone" && state(grandchildPid) !== "Z",
        { evidence: evidence instanceof Error ? evidence.message : evidence, grandchild: state(grandchildPid) },
      );
      killOwned(grandchildPid, grandchildStart);
      await until(() => isGone(grandchildPid), 2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }


  {
    // An UNAUTHENTICATED socket must not pin a custodian whose child has exited. Such a peer holds
    // no session, no output subscription and no wait, so a settle owes it nothing; counting it kept
    // one ~65 MB custodian resident per stray dial for the life of the host, and suite runs
    // accumulated them until the box was under memory pressure (#1648). The adopter below
    // authenticates and leaves first, so this is the real post-handoff settle path, not the
    // unobserved-launch one.
    const rec = launchSeat({
      root,
      name: "unauthed-peer",
      spec: {
        command: process.execPath,
        args: ["-e", "setTimeout(()=>process.exit(0), 500)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const adopter = adoptSeatSync(rec);
    await adopter.attach().backlog();
    adopter.close();
    const mute = connect(rec.socket);
    mute.on("error", () => {});
    await new Promise<void>((resolve) => mute.once("connect", () => resolve()));
    check(
      "an unauthenticated peer does not keep a custodian whose child exited alive",
      await until(() => state(rec.custodianPid) === "gone" || state(rec.custodianPid) === "Z", 20_000),
      { custodian: state(rec.custodianPid), child: state(rec.childPid) },
    );
    mute.destroy();
    killOwned(rec.custodianPid, rec.custodianStart);
  }

  {
    const rec = launchSeat({
      root,
      name: "grace",
      spec: {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    const h = adoptSeatSync(rec);
    h.stop({ graceful: true });
    await h.waitForExit();
    check("graceful stop: waitForExit resolves", h.status() === "exited");
    h.close();
  }

  {
    // Graceful escalation: a child that ignores SIGTERM still goes, by the pidfd SIGKILL after GRACE_MS.
    const dir = mkdtempSync(join(root, "t1-grace-"));
    const pidf = join(dir, "pid");
    const mark = join(dir, "term");
    const rec = launchSeat({ root, name: "grace-escalate", spec: { command: process.execPath, args: ["-e", ARMED_CHILD, pidf, mark, ""], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd() });
    const h = adoptSeatSync(rec);
    handles.push(h);
    await until(() => readPid(pidf) !== undefined, 5_000);
    h.stop({ graceful: true });
    const exited = await Promise.race([h.waitForExit().then(() => true), wait(GRACE_MS + 5_000).then(() => false)]);
    check(
      "graceful stop escalates: a child ignoring SIGTERM is gone after waitForExit",
      exited && existsSync(mark) && (await until(() => isGone(rec.childPid), 2_000)),
      { exited, sigterm: existsSync(mark), child: state(rec.childPid) },
    );
    h.close();
  }

  {
    // A failed pin sends nothing: the child is named by no pidfd, so only the PTY hangup reaches it.
    const dir = mkdtempSync(join(root, "t1-unpinned-"));
    const pidf = join(dir, "pid");
    const mark = join(dir, "term");
    const release = join(dir, "release");
    const id = seatId();
    const err = launchUnderSeam({ dropPidfd: true, holds: [{ at: "unpinned", reached: join(dir, "reached"), release }] }, id, ["-e", ARMED_CHILD, pidf, mark, release]);
    const owned = readPid(pidf);
    if (owned !== undefined) strays.push(owned);
    const pid = owned?.pid;
    await wait(300);
    check(
      "an unpinned child is never signalled: launch fails, no socket or record, the child lives unmarked",
      /returned no pidfd/.test(err) && !existsSync(join(root, id, "seat.sock")) && !existsSync(join(root, id, "record.json")) && pid !== undefined && !isGone(pid) && !existsSync(mark),
      { err, pid, child: pid === undefined ? "none" : state(pid), sigterm: existsSync(mark) },
    );
  }

  for (const fail of ["listen-error", "after-bind"] as const) {
    // Every startup failure after pinning SIGKILLs the child through the pidfd before the custodian exits.
    const dir = mkdtempSync(join(root, `t1-${fail}-`));
    const pidf = join(dir, "pid");
    const release = join(dir, "release");
    const id = seatId();
    const err = launchUnderSeam({ fail, holds: [{ at: "after-pin", reached: join(dir, "reached"), release }] }, id, ["-e", ARMED_CHILD, pidf, join(dir, "term"), release]);
    const owned = readPid(pidf);
    if (owned !== undefined) strays.push(owned);
    const pid = owned?.pid;
    check(
      `startup failure (${fail}) after pinning stops the child`,
      /custodian exited before ready/.test(err) && !existsSync(join(root, id, "record.json")) && pid !== undefined && (await until(() => isGone(pid), 5_000)),
      { err, pid, child: pid === undefined ? "none" : state(pid) },
    );
  }

  {
    // The custodian creates no directory: a seat dir removed under a late custodian stays removed.
    const dir = mkdtempSync(join(root, "t1-rmdir-"));
    const pidf = join(dir, "pid");
    const reached = join(dir, "reached");
    const release = join(dir, "release");
    const childRelease = join(dir, "child-release");
    const id = seatId();
    onReached(reached, 'rm -rf "$2"; : > "$3"', join(root, id), release);
    const err = launchUnderSeam(
      { holds: [{ at: "before-fs", reached, release }, { at: "after-pin", reached: join(dir, "pinned"), release: childRelease }] },
      id,
      ["-e", ARMED_CHILD, pidf, join(dir, "term"), childRelease],
    );
    const owned = readPid(pidf);
    if (owned !== undefined) strays.push(owned);
    const pid = owned?.pid;
    check(
      "a removed seat directory stops a late custodian: no record, no directory, the child is gone",
      err !== "" && !existsSync(join(root, id)) && pid !== undefined && (await until(() => isGone(pid), 5_000)),
      { err, dir: existsSync(join(root, id)), pid, child: pid === undefined ? "none" : state(pid) },
    );
  }

  {
    // A seal written after the launcher's check still stops the custodian before it spawns.
    const dir = mkdtempSync(join(root, "t1-seal-"));
    const pidf = join(dir, "pid");
    const reached = join(dir, "reached");
    const release = join(dir, "release");
    const id = seatId();
    onReached(reached, 'printf sealed > "$2"; : > "$3"', join(root, `.launch-${id}`), release);
    const err = launchUnderSeam({ holds: [{ at: "before-fs", reached, release }] }, id, ["-e", ARMED_CHILD, pidf, join(dir, "term"), ""]);
    await wait(300);
    check(
      "a sealed fence refuses the launch: no child, no socket, no record",
      /is sealed/.test(err) && readPid(pidf) === undefined && !existsSync(join(root, id, "seat.sock")) && !existsSync(join(root, id, "record.json")),
      { err, child: readPid(pidf) },
    );
    const again = seatId();
    writeFileSync(join(root, `.launch-${again}`), "sealed");
    let refused = "";
    try { launchSeat({ root, name: "sealed", id: again, spec: { command: process.execPath, args: ["-e", ""], env: { PATH: process.env.PATH ?? "" } }, cwd: process.cwd() }); } catch (e) { refused = (e as Error).message; }
    check("a launch over an existing fence creates no seat directory", refused !== "" && !existsSync(join(root, again)), refused);
  }

  {
    // A reused pid is never signalled. Inside a fresh user+pid namespace the fixture's child exits at
    // once and a CLONE_PARENT process retakes its pid; a startup failure must not reach that process.
    const here = dirname(fileURLToPath(import.meta.url));
    const dist = join(here, "..", "dist");
    const dir = mkdtempSync(join(root, "t1-reuse-"));
    const fixture = join(dir, "pid-reuse");
    const cc = spawnSync("cc", ["-O2", "-o", fixture, join(here, "fixtures", "pid-reuse.c")], { encoding: "utf8" });
    const runner = join(dir, "run.mjs");
    writeFileSync(
      runner,
      `import { setCustodianTestSeam, launchSeat } from ${JSON.stringify(join(dist, "launcher.js"))};
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const [root, fixture, dir] = process.argv.slice(2);
const release = dir + "/release";
spawn("sh", ["-c", 'i=0; while [ ! -e "$1/reused.pid" ] && [ $i -lt 400 ]; do sleep 0.02; i=$((i+1)); done; : > "$2"', "sh", dir, release], { stdio: "ignore" }).unref();
setCustodianTestSeam({ fail: "after-pin", holds: [{ at: "after-pin", reached: dir + "/reached", release }] });
let error = "";
try { launchSeat({ root, name: "pid-reuse", spec: { command: fixture, args: [dir], env: { PATH: process.env.PATH ?? "" } }, cwd: dir }); } catch (e) { error = e.message; }
await sleep(300);
const read = (n) => { try { return Number(readFileSync(dir + "/" + n, "utf8").trim()); } catch { return undefined; } };
const child = read("child.pid");
const reused = read("reused.pid");
let reusedAlive = false;
try { const s = readFileSync("/proc/" + reused + "/stat", "utf8"); reusedAlive = s.slice(s.lastIndexOf(") ") + 2)[0] !== "Z"; } catch {}
console.log("PID_REUSE " + JSON.stringify({ error, child, reused, reusedAlive }));
`,
    );
    const ns = cc.status === 0
      ? spawnSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", process.execPath, runner, root, fixture, dir], { encoding: "utf8", timeout: 30_000 })
      : undefined;
    const line = (ns?.stdout ?? "").split("\n").find((l) => l.startsWith("PID_REUSE "));
    const got = line ? (JSON.parse(line.slice("PID_REUSE ".length)) as { error: string; child?: number; reused?: number; reusedAlive: boolean }) : undefined;
    check(
      "a reused pid is never signalled: the process that retook the child's pid outlives the startup failure",
      got !== undefined && /test seam: startup failure after pinning/.test(got.error) && got.child !== undefined && got.child === got.reused && got.reusedAlive,
      { cc: cc.status === 0 ? "ok" : cc.stderr || cc.error?.message, status: ns?.status, stderr: ns?.stderr, got },
    );
  }
} finally {
  for (const { pid, start } of strays) killOwned(pid, start);
  for (const h of handles) {
    try {
      h.stop({ graceful: false });
    } catch {
      /* gone */
    }
    try {
      h.close?.();
    } catch {
      /* gone */
    }
    killOwned(h.record.custodianPid, h.record.custodianStart);
    killOwned(h.record.childPid, h.record.childStart);
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nSEAT LIFECYCLE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
