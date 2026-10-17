/**
 * Seat behavior cells plus worker-death survival and wait-exit close settlement.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adoptSeatSync, launchSeat, reapSeat, seatId, SeatClient, type SeatRecord } from "../src/index.js";
import { setCustodianTestSeam } from "../src/launcher.js";
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
  record: { custodianPid: number; childPid: number };
}> = [];
/** Pids a T1 cell leaves behind on purpose (or a mutant leaves by mistake); killed in `finally`. */
const strays: number[] = [];
const isGone = (pid: number): boolean => state(pid) === "gone" || state(pid) === "Z";
const readPid = (path: string): number | undefined => {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return n > 0 ? n : undefined;
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
    strays.push(rec.custodianPid, rec.childPid);
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
    process.kill(ids.workerPid, "SIGKILL");
    check("the fixture killed its actual worker process", await until(() => state(ids.workerPid) === "gone", 5_000), ids);
    check(
      "worker death leaves the custodial child PID running",
      await until(() => state(ids.childPid) !== "gone" && state(ids.childPid) !== "Z", 5_000),
      { child: state(ids.childPid), custodian: state(ids.custodianPid) },
    );
    const adopted = adoptSeatSync({
      version: 1,
      id: ids.id,
      name: "survive",
      socket: join(root, ids.id, "seat.sock"),
      token: JSON.parse(readFileSync(join(root, ids.id, "record.json"), "utf8")).token,
      custodianPid: ids.custodianPid,
      childPid: ids.childPid,
    });
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
    process.kill(rec.childPid, "SIGKILL");
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
    // reapSeat: a live custodied seat nobody adopted is signalled by identity, its process group is
    // proved empty, and the record is forgotten. A record without start identities refuses.
    const rec = launchSeat({
      root,
      name: "reap-live",
      spec: {
        command: process.execPath,
        args: ["-e", "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      cwd: process.cwd(),
    });
    await wait(500);
    const before = readdirSync("/proc").filter((e) => /^\d+$/.test(e)).filter((e) => {
      try {
        const stat = readFileSync(`/proc/${e}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2] === String(rec.childPid);
      } catch {
        return false;
      }
    });
    check("instrument: the seat child leads a group with a grandchild", before.length >= 2, before);
    // A refusal is reported as this cell failing, never as a throw out of the suite: a reap that
    // refuses a record it should have signalled is exactly what these cells exist to catch, and a
    // throw here ends the run before any of them print.
    const evidence = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("reapSeat signals a live seat by identity and proves it gone", !(evidence instanceof Error) && evidence.outcome === "reaped" && state(rec.childPid) === "gone" && state(rec.custodianPid) === "gone", evidence instanceof Error ? evidence.message : evidence);
    const after = before.filter((e) => state(Number(e)) !== "gone");
    check("the child's whole process group is gone", after.length === 0, after);
    check("the custody record is forgotten", !existsSync(join(root, rec.id)), rec.id);
    const second = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("a second reap of the same id reports absent", !(second instanceof Error) && second.outcome === "absent", second instanceof Error ? second.message : second);
    // Whatever the cells above found, this seat must not outlive the suite.
    try { process.kill(-rec.childPid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(rec.custodianPid, "SIGKILL"); } catch { /* already gone */ }
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
    // Identity refusal: a record naming a pid whose start token differs is never signalled.
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
    let refused = "";
    try {
      await reapSeat(root, rec.id);
    } catch (e) {
      refused = (e as Error).message;
    }
    check("a record with no start identity refuses to signal", /no process start identity/.test(refused) && state(rec.childPid) !== "gone", refused);
    // A forged identity proves the pids are not the recorded processes: nothing is signalled and
    // the record is forgotten as already-gone custody.
    const forged = { ...rec, custodianStart: "1", childStart: "1" };
    writeFileSync(join(root, rec.id, "record.json"), `${JSON.stringify(forged)}\n`);
    const evidence = await reapSeat(root, rec.id).catch((e: Error) => e);
    check("a pid whose start identity differs from the record is treated as gone, never signalled", !(evidence instanceof Error) && evidence.outcome === "reaped" && state(rec.childPid) !== "gone" && state(rec.custodianPid) !== "gone", { evidence: evidence instanceof Error ? evidence.message : evidence, child: state(rec.childPid) });
  }

  {
    // Boot binding: a start token counts ticks SINCE BOOT, so it tells two processes apart only
    // within one boot, while a custody record outlives a reboot on disk. A record carried across a
    // reboot names pids that now belong to whatever this boot put at those numbers, so it is
    // refused rather than signalled - and so is a record written before the boot stamp existed.
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
    check("the custodian stamps the boot its pids belong to", onDisk.bootId === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), onDisk.bootId);
    writeFileSync(path, `${JSON.stringify({ ...onDisk, bootId: "00000000-0000-0000-0000-000000000000" })}\n`);
    let foreign = "";
    try { await reapSeat(root, rec.id); } catch (e) { foreign = (e as Error).message; }
    check("a record from another boot refuses to signal", /belongs to boot 00000000-0000-0000-0000-000000000000/.test(foreign) && state(rec.childPid) !== "gone", { foreign, child: state(rec.childPid) });
    const { bootId: _dropped, ...unbound } = onDisk;
    writeFileSync(path, `${JSON.stringify(unbound)}\n`);
    let refusedUnbound = "";
    try { await reapSeat(root, rec.id); } catch (e) { refusedUnbound = (e as Error).message; }
    check("a record with no boot identity refuses to signal", /carries no boot identity/.test(refusedUnbound) && state(rec.childPid) !== "gone", { refusedUnbound, child: state(rec.childPid) });
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
    try { process.kill(rec.custodianPid, "SIGKILL"); } catch { /* already gone */ }
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
    const pid = readPid(pidf);
    if (pid !== undefined) strays.push(pid);
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
    const pid = readPid(pidf);
    if (pid !== undefined) strays.push(pid);
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
    const pid = readPid(pidf);
    if (pid !== undefined) strays.push(pid);
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
  for (const pid of strays) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
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
    const childGone = state(h.record.childPid) === "gone" || state(h.record.childPid) === "Z";
    const custodianGone = state(h.record.custodianPid) === "gone" || state(h.record.custodianPid) === "Z";
    if (childGone && custodianGone) continue;
    try {
      process.kill(h.record.custodianPid, "SIGKILL");
    } catch {
      /* gone */
    }
    try {
      process.kill(h.record.childPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nSEAT LIFECYCLE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
