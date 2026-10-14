// Layer 3 (T5): per-seat cgroup v2 custody. The orchestrator runs every cell in its own fresh
// delegated scope, so no cell creates a cgroup under this process's own scope.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { checkSeatRelease, launchSeat, processStartToken, reapSeat, sealSeatLaunch, seatCgroupContained, seatCgroupPath, seatCgroupPopulated, seatId, type SeatLaunchSpec } from "../src/index.js";
import { removeSeatCgroup } from "../src/cgroup.js";
import { setCustodianTestSeam, setLauncherTestSeam } from "../src/launcher.js";
import { pidfdOpen, pidfdSignal } from "../src/peercred.js";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log(`SEAT CGROUP COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

const SCRIPT = fileURLToPath(import.meta.url);
const DIST = join(dirname(SCRIPT), "..", "dist");
const CELLS = ["refusal", "shared-uid", "unprovable", "release-join", "rollback", "bounds", "wrong-base", "distinct-uid", "setsid", "recordless", "fence"] as const;
type Cell = (typeof CELLS)[number];
const NEEDS_DISTINCT_UID: Record<Cell, boolean> = { refusal: false, "shared-uid": false, unprovable: false, "release-join": false, rollback: false, bounds: false, "wrong-base": false, "distinct-uid": true, setsid: true, recordless: true, fence: true };
const REQUIRE = process.env.COTAL_SEAT_CGROUP_REQUIRE === "1";

const ownCgroup = (): string => {
  const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) throw new Error("no cgroup v2 line in /proc/self/cgroup");
  return line.slice(3);
};

const cellAt = process.argv.indexOf("--cell");
if (cellAt < 0) orchestrate();
else await runCell(process.argv[cellAt + 1]);

function orchestrate(): void {
  const euid = process.geteuid?.() ?? -1;
  const scope = euid === 0 ? ["systemd-run", "--scope", "-p", "Delegate=yes", "--quiet", "--"] : ["systemd-run", "--user", "--scope", "-p", "Delegate=yes", "--quiet", "--"];
  const scopeOk = spawnSync(scope[0] ?? "", [...scope.slice(1), "true"], { stdio: "ignore", timeout: 15_000 }).status === 0;

  // A distinct agent uid: a created user under root (CI), else a mapped uid in a user namespace.
  let agent: { uid: number; gid: number; prefix: string[] } | undefined;
  let agentWhy = "";
  if (euid === 0) {
    const uid = Number(process.env.COTAL_SEAT_SMOKE_AGENT_UID ?? "");
    const gid = Number(spawnSync("id", ["-g", String(uid)], { encoding: "utf8" }).stdout.trim());
    if (Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid >= 0) agent = { uid, gid, prefix: [] };
    else agentWhy = "root run without a resolvable COTAL_SEAT_SMOKE_AGENT_UID";
  } else {
    const prefix = ["unshare", "--user", "--map-auto", "--map-root-user", "--"];
    const pick = spawnSync("getent", ["passwd"], { encoding: "utf8" }).stdout.split("\n")
      .map((l) => l.split(":"))
      .map((f) => ({ uid: Number(f[2]), gid: Number(f[3]) }))
      .find((p) => Number.isInteger(p.uid) && p.uid > 0 && p.uid < 65534 && p.uid !== euid && Number.isInteger(p.gid) && p.gid > 0 && p.gid < 65534);
    const probe = pick && scopeOk
      ? spawnSync(scope[0] ?? "", [...scope.slice(1), ...prefix, "setpriv", "--reuid", String(pick.uid), "--regid", String(pick.gid), "--init-groups", "true"], { stdio: "ignore", timeout: 15_000 })
      : undefined;
    if (pick && probe?.status === 0) agent = { ...pick, prefix };
    else agentWhy = "no root and no mapped user namespace (unshare --map-auto) to run a second uid";
  }

  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const cell of CELLS) {
    console.log(`\n[${cell}]`);
    const why = !scopeOk ? "no delegated cgroup scope (systemd-run --scope -p Delegate=yes)" : NEEDS_DISTINCT_UID[cell] && !agent ? `needs a distinct uid: ${agentWhy}` : "";
    if (why) {
      console.log(`  - skipped: ${why}`);
      if (REQUIRE) fail++;
      else skip++;
      continue;
    }
    const prefix = NEEDS_DISTINCT_UID[cell] && agent ? agent.prefix : [];
    const r = spawnSync(scope[0] ?? "", [...scope.slice(1), ...prefix, process.execPath, ...process.execArgv, SCRIPT, "--cell", cell], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, COTAL_CG_PARENT: ownCgroup(), COTAL_CG_AGENT_UID: String(agent?.uid ?? ""), COTAL_CG_AGENT_GID: String(agent?.gid ?? "") },
    });
    process.stdout.write(r.stdout ?? "");
    if (r.stderr) process.stdout.write(r.stderr.split("\n").map((l) => (l ? `    | ${l}` : l)).join("\n"));
    // A cell passes only on exit 0 with exactly one well-formed tally that ran a check or says it skipped.
    const tallies = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("CELL_TALLY "));
    const t = tallies.length === 1 ? parseTally(tallies[0]?.slice("CELL_TALLY ".length) ?? "") : undefined;
    if (r.status !== 0 || t === undefined) {
      console.log(`  ✗ FAIL: cell ${cell} exited ${String(r.status ?? r.signal)} with ${tallies.length} tally line(s)${t === undefined ? ", none well-formed" : ""}`);
      fail++;
    } else if (t.skipped) {
      if (REQUIRE) fail++;
      else skip++;
    } else if (t.pass === 0) {
      console.log(`  ✗ FAIL: cell ${cell} ran no passing check and did not report a skip`);
      fail++;
    }
    pass += t?.pass ?? 0;
    fail += t?.fail ?? 0;
  }
  console.log(`\nSEAT CGROUP ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed, ${skip} skipped)`);
  process.exitCode = fail === 0 ? 0 : 1;
}

function parseTally(text: string): { pass: number; fail: number; skipped: boolean } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null || !("pass" in v) || !("fail" in v) || !("skipped" in v)) return undefined;
  const { pass, fail, skipped } = v;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return count(pass) && count(fail) && typeof skipped === "boolean" ? { pass, fail, skipped } : undefined;
}

async function runCell(cell: string | undefined): Promise<void> {
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
  const wait = (ms: number): Promise<void> => sleep(ms);
  const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await wait(25);
    return predicate();
  };
  const gone = (pid: number): boolean => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z");
    } catch {
      return true;
    }
  };
  type Owned = { pid: number; start: string | undefined };
  const strays: Owned[] = [];
  // As lifecycle.smoke.ts: the pidfd pins one process before its start token is checked.
  const killOwned = ({ pid, start }: Owned): void => {
    if (pid <= 1 || start === undefined) return;
    const fd = pidfdOpen(pid);
    if (fd === undefined) return;
    try {
      if (processStartToken(pid) === start) pidfdSignal(fd, "SIGKILL");
    } catch { /* already gone */ } finally {
      closeSync(fd);
    }
  };
  const readPid = (path: string): Owned | undefined => {
    try {
      const n = Number(readFileSync(path, "utf8").trim());
      return n > 1 ? { pid: n, start: processStartToken(n) } : undefined;
    } catch {
      return undefined;
    }
  };
  const readOr = (path: string, fallback: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return fallback;
    }
  };

  const own = ownCgroup();
  // Safety: a cell runs only in a fresh scope, never in the orchestrator's own cgroup.
  if (own === process.env.COTAL_CG_PARENT || !own.endsWith(".scope")) throw new Error(`cell ${String(cell)} is not in a fresh scope: ${own}`);
  const base = `/sys/fs/cgroup${own}`;
  const euid = process.geteuid?.() ?? -1;
  const agentUid = Number(process.env.COTAL_CG_AGENT_UID || "-1");
  const agentGid = Number(process.env.COTAL_CG_AGENT_GID || "-1");
  const root = makeSeatRoot("cotal-seat-cg-");
  // Agent-uid children need a directory they can traverse and write; the seat root is 0700.
  const agentDir = mkdtempSync("/tmp/cotal-cg-agent-");
  chmodSync(agentDir, 0o777);
  const created: string[] = [];
  const env = { PATH: process.env.PATH ?? "" };
  const asAgent = (args: string[]): SeatLaunchSpec =>
    agentUid > 0 && agentUid !== euid
      ? { command: "setpriv", args: ["--reuid", String(agentUid), "--regid", String(agentGid), "--init-groups", "--", process.execPath, ...args], env }
      : { command: process.execPath, args, env };
  const launch = (id: string, spec: SeatLaunchSpec) => {
    created.push(seatCgroupPath(base, id));
    const rec = launchSeat({ root, name: `t5-${String(cell)}`, id, spec, cwd: agentDir, cgroupBase: base });
    strays.push({ pid: rec.custodianPid, start: rec.custodianStart }, { pid: rec.childPid, start: rec.childStart });
    return rec;
  };
  const file = (name: string): string => join(agentDir, name);
  const IGNORE = "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});";
  // Writes its migration result, then its pid, so a pid file implies the result is there.
  const MIGRATE_CHILD =
    `const fs=require('fs');const [pidf,mark,base]=process.argv.slice(1);${IGNORE}` +
    "let r;try{fs.writeFileSync(base+'/cgroup.procs',String(process.pid));r='moved'}catch(e){r='denied:'+e.code}" +
    "fs.writeFileSync(mark,r);fs.writeFileSync(pidf,String(process.pid));setInterval(()=>{},1000);";
  const SETSID_CHILD =
    `const {spawn}=require('child_process');const fs=require('fs');const [pidf,gpidf]=process.argv.slice(1);${IGNORE}` +
    `const g=spawn(process.execPath,['-e',${JSON.stringify(`${IGNORE}require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`)},gpidf],{detached:true,stdio:'ignore'});g.unref();` +
    "setTimeout(()=>fs.writeFileSync(pidf,String(process.pid)),200);setInterval(()=>{},1000);";
  const SLEEPER = `const fs=require('fs');${IGNORE}fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  const runner = (name: string, body: string): string => {
    const path = join(agentDir, name);
    writeFileSync(path, body);
    return path;
  };
  const reapRunner = runner(
    "reap.mjs",
    `import { writeFileSync } from "node:fs";
import { reapSeat } from ${JSON.stringify(join(DIST, "index.js"))};
const [root, id, path, uid, out] = process.argv.slice(2);
writeFileSync(out, JSON.stringify(await reapSeat(root, id, { cgroup: { path, agentUid: Number(uid) } })));
`,
  );
  const releaseRunner = runner(
    "release.mjs",
    `import { writeFileSync } from "node:fs";
import { sealSeatLaunch, setReleaseTestSeam } from ${JSON.stringify(join(DIST, "reap.js"))};
const [root, id, path, uid, out, reached, release] = process.argv.slice(2);
if (reached) setReleaseTestSeam({ afterPopulated: { reached, release } });
writeFileSync(out, JSON.stringify(await sealSeatLaunch(root, id, { cgroup: { path, agentUid: Number(uid) } })));
`,
  );
  /** Run `then` (sh, args $2…) once `reached` exists; launchSeat blocks this event loop meanwhile. */
  const onReached = (reached: string, then: string, ...args: string[]): void => {
    const script = `i=0; while [ ! -e "$1" ] && [ $i -lt 1000 ]; do sleep 0.02; i=$((i+1)); done; ${then}`;
    spawn("sh", ["-c", script, "sh", reached, ...args], { stdio: "ignore" }).unref();
  };
  const fenceSealed = (id: string): boolean => readOr(join(root, `.launch-${id}`), "") === "sealed";

  let skipped = false;
  try {
    // Without a distinct agent uid, asAgent runs as the manager, which would pass these cells vacuously.
    const known = CELLS.find((c) => c === cell);
    if (known !== undefined && NEEDS_DISTINCT_UID[known] && !(agentUid > 0 && agentUid !== euid && agentGid >= 0)) {
      skipped = true;
      console.log(`  - skipped: needs a distinct uid, got agent uid ${agentUid} with euid ${euid}`);
      cell = "skipped";
    }
    switch (cell) {
      case "skipped":
        break;
      case "refusal": {
        // T4's deferred cell: under layer 3 a populated cgroup refuses the release.
        const id = seatId();
        launch(id, { command: process.execPath, args: ["-e", SLEEPER, file("pid")], env });
        const cg = { path: seatCgroupPath(base, id), agentUid: euid };
        const checked = checkSeatRelease(root, id, { cgroup: cg });
        check("refusal: checkSeatRelease refuses a populated seat cgroup", !checked.ok && checked.reason === "populated", checked);
        const sealed = await sealSeatLaunch(root, id, { cgroup: cg });
        check("refusal: sealSeatLaunch refuses a populated seat cgroup, leaves it and the fence unsealed",
          !sealed.ok && sealed.reason === "populated" && existsSync(cg.path) && !fenceSealed(id), sealed);
        writeFileSync(join(cg.path, "cgroup.kill"), "1");
        await until(() => !seatCgroupPopulated(cg), 5_000);
        const empty = await sealSeatLaunch(root, id, { cgroup: cg });
        check("refusal: an empty seat cgroup is removed under the fence lock and the fence is sealed",
          empty.ok && !existsSync(cg.path) && fenceSealed(id), empty);
        break;
      }
      case "shared-uid": {
        const id = seatId();
        const rec = launch(id, { command: process.execPath, args: ["-e", MIGRATE_CHILD, file("pid"), file("mark"), base], env });
        await until(() => existsSync(file("pid")), 5_000);
        const child = readPid(file("pid"));
        if (child) strays.push(child);
        const cg = { path: seatCgroupPath(base, id), agentUid: euid };
        check("migration attempt, shared uid: the child moves itself out to the base", readOr(file("mark"), "") === "moved", readOr(file("mark"), "none"));
        check("migration attempt, shared uid: seatCgroupContained is false", !seatCgroupContained(cg));
        const evidence = await reapSeat(root, id, { cgroup: cg, graceMs: 1_000 });
        check("migration attempt, shared uid: the reap is retained, not reaped, and the seat cgroup is not removed",
          evidence.outcome === "retained" && evidence.reason === "unprovable" && existsSync(cg.path), { evidence, rec: rec.childPid });
        break;
      }
      case "unprovable": {
        const id = seatId();
        launch(id, { command: process.execPath, args: ["-e", SLEEPER, file("pid")], env });
        // No passwd entry: groups cannot be read, so the grant is unverifiable.
        const cg = { path: seatCgroupPath(base, id), agentUid: 2_147_000_001 };
        check("migration attempt, unprovable grant: seatCgroupContained is false for a uid with no groups", !seatCgroupContained(cg));
        const evidence = await reapSeat(root, id, { cgroup: cg, graceMs: 1_000 });
        check("migration attempt, unprovable grant: the reap is retained and the seat cgroup is not removed",
          evidence.outcome === "retained" && evidence.reason === "unprovable" && existsSync(cg.path), evidence);
        break;
      }
      case "distinct-uid": {
        const id = seatId();
        const procs = join(base, "cgroup.procs");
        const before = statSync(procs);
        // Group-writable for a group the agent is not in: still no grant.
        chmodSync(procs, 0o664);
        launch(id, asAgent(["-e", MIGRATE_CHILD, file("pid"), file("mark"), base]));
        await until(() => existsSync(file("pid")), 5_000);
        const child = readPid(file("pid"));
        if (child) strays.push(child);
        const cg = { path: seatCgroupPath(base, id), agentUid };
        const groups = spawnSync("id", ["-G", String(agentUid)], { encoding: "utf8" }).stdout.trim().split(/\s+/).map(Number);
        check("migration attempt, distinct uid: the write to base cgroup.procs fails with a group-writable ancestor",
          /^denied:EACCES/.test(readOr(file("mark"), "")) && !groups.includes(before.gid), { mark: readOr(file("mark"), "none"), groups, gid: before.gid });
        check("migration attempt, distinct uid: seatCgroupContained is true", seatCgroupContained(cg));
        check("migration attempt, distinct uid: the child is alive in the seat cgroup before the kill",
          child !== undefined && !gone(child.pid) && seatCgroupPopulated(cg));
        // The same ancestor granted to the agent's own group is a grant the agent can use.
        chownSync(procs, before.uid, agentGid);
        const granted = seatCgroupContained(cg);
        chownSync(procs, before.uid, before.gid);
        chmodSync(procs, before.mode & 0o7777);
        check("migration attempt, group grant: an ancestor writable by the agent's group is not contained", !granted);
        const evidence = await reapSeat(root, id, { cgroup: cg });
        check("migration attempt, distinct uid: the reap is reaped after the kill, the child is gone and the cgroup removed",
          evidence.outcome === "reaped" && child !== undefined && gone(child.pid) && !existsSync(cg.path), evidence);
        break;
      }
      case "setsid": {
        const id = seatId();
        launch(id, asAgent(["-e", SETSID_CHILD, file("pid"), file("gpid")]));
        await until(() => existsSync(file("pid")) && existsSync(file("gpid")), 5_000);
        const grand = readPid(file("gpid"));
        if (grand) strays.push(grand);
        const path = seatCgroupPath(base, id);
        let busy = "";
        try {
          removeSeatCgroup({ path, agentUid });
        } catch (e) {
          busy = (e as NodeJS.ErrnoException).code ?? "";
        }
        check("setsid: rmdir refuses the populated seat cgroup", busy === "EBUSY", busy);
        // A new runtime instance: another process proves the cgroup through the derived path alone.
        const out = file("reap.json");
        spawnSync(process.execPath, [reapRunner, root, id, path, String(agentUid), out], { stdio: "ignore", timeout: 30_000 });
        const evidence = readOr(out, "{}");
        check("setsid: a new instance reaps through the derived path; the setsid escapee is gone and the cgroup removed",
          JSON.parse(evidence).outcome === "reaped" && grand !== undefined && gone(grand.pid) && !existsSync(path), { evidence, grand });
        break;
      }
      case "recordless": {
        const id = seatId();
        launch(id, asAgent(["-e", SLEEPER, file("pid")]));
        await until(() => existsSync(file("pid")), 5_000);
        const child = readPid(file("pid"));
        if (child) strays.push(child);
        unlinkSync(join(root, id, "record.json"));
        const cg = { path: seatCgroupPath(base, id), agentUid };
        const evidence = await reapSeat(root, id, { cgroup: cg });
        check("record-less seat: the reap is reaped, the child is gone and the cgroup removed",
          evidence.outcome === "reaped" && child !== undefined && gone(child.pid) && !existsSync(cg.path), evidence);
        break;
      }
      case "fence": {
        const id = seatId();
        const path = seatCgroupPath(base, id);
        const reached = file("reached");
        const release = file("release");
        const out = file("reap.json");
        onReached(reached, 'NODE="$2"; shift 2; "$NODE" "$@"; : > "$7"', process.execPath, reapRunner, root, id, path, String(agentUid), out, release);
        setLauncherTestSeam({ beforeMove: { reached, release } });
        let err = "";
        try {
          launch(id, asAgent(["-e", SLEEPER, file("pid")]));
        } catch (e) {
          err = (e as Error).message;
        } finally {
          setLauncherTestSeam(undefined);
        }
        await wait(500);
        const child = readPid(file("pid"));
        if (child) strays.push(child);
        check("launch/reap fence: the reap of the empty cgroup is reaped, the move fails with ENOENT and no child exists",
          JSON.parse(readOr(out, "{}")).outcome === "reaped" && /ENOENT/.test(err) && child === undefined && !existsSync(path),
          { err, out: readOr(out, "none"), child });
        break;
      }
      case "release-join": {
        const id = seatId();
        const path = seatCgroupPath(base, id);
        const [lReached, lRelease, rReached, rRelease, cReached, cRelease, out] = ["l-reached", "l-release", "r-reached", "r-release", "c-reached", "c-release", "release.json"].map(file);
        // Release reads populated 0 and holds; the launcher then moves the custodian in; then the
        // release runs its rmdir; only then is the custodian let go.
        const then =
          'NODE="$2"; "$NODE" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" & ' +
          'i=0; while [ ! -e "$9" ] && [ $i -lt 1000 ]; do sleep 0.02; i=$((i+1)); done; : > "${11}"; ' +
          'i=0; until grep -q "^populated 1" "$6/cgroup.events" 2>/dev/null || [ $i -ge 1000 ]; do sleep 0.02; i=$((i+1)); done; : > "${10}"; ' +
          'i=0; while [ ! -s "$8" ] && [ $i -lt 1000 ]; do sleep 0.02; i=$((i+1)); done; : > "${12}"';
        onReached(lReached, then, process.execPath, releaseRunner, root, id, path, String(euid), out, rReached, rRelease, lRelease, cRelease);
        setLauncherTestSeam({ beforeMove: { reached: lReached, release: lRelease } });
        setCustodianTestSeam({ holds: [{ at: "before-fs", reached: cReached, release: cRelease }] });
        let err = "";
        try {
          launch(id, { command: process.execPath, args: ["-e", SLEEPER, file("pid")], env });
        } catch (e) {
          err = (e as Error).message;
        } finally {
          setLauncherTestSeam(undefined);
          setCustodianTestSeam(undefined);
        }
        await until(() => existsSync(file("pid")), 5_000);
        const result = readOr(out, "{}");
        const parsed = JSON.parse(result) as { ok?: boolean; reason?: string };
        check("release/join race: the release refuses with populated, writes no seal, and the seat stays live",
          parsed.ok === false && parsed.reason === "populated" && !fenceSealed(id) && err === "" && existsSync(file("pid")) && existsSync(path),
          { result, err, fence: readOr(join(root, `.launch-${id}`), "none") });
        break;
      }
      case "rollback": {
        const id = seatId();
        const path = seatCgroupPath(base, id);
        setLauncherTestSeam({ failMove: true });
        let err = "";
        try {
          launch(id, { command: process.execPath, args: ["-e", SLEEPER, file("pid")], env });
        } catch (e) {
          err = (e as Error).message;
        } finally {
          setLauncherTestSeam(undefined);
        }
        // The custodian is past spawn and polls every 25ms; give it far longer than that to misbehave.
        await wait(1_500);
        check("launch rollback: a failed move throws and leaves no seat cgroup, no record and no child",
          /seat cgroup move failed/.test(err) && !existsSync(path) && !existsSync(file("pid")) && !existsSync(join(root, id, "record.json")),
          { err, cgroup: existsSync(path), child: existsSync(file("pid")) });
        break;
      }
      case "bounds": {
        const id = seatId();
        launch(id, { command: process.execPath, args: ["-e", SLEEPER, file("pid")], env });
        const real = seatCgroupPath(base, id);
        const throws = (f: () => unknown): boolean => {
          try {
            f();
            return false;
          } catch {
            return true;
          }
        };
        const rejects = async (f: () => Promise<unknown>): Promise<boolean> => f().then(() => false, () => true);
        check("bounds: seatCgroupPath rejects a `..` base, a trailing slash, a `.` segment and the bare root",
          throws(() => seatCgroupPath(`${base}/..`, id)) && throws(() => seatCgroupPath(`${base}/`, id)) &&
            throws(() => seatCgroupPath(`${base}/./x`, id)) && throws(() => seatCgroupPath("/sys/fs/cgroup", id)));
        // The same seat cgroup, spelled through `..`: no kill, no rmdir, no release may follow it.
        const dotted = { path: `${base}/x/../seat-${id}`, agentUid: euid };
        const doubled = { path: `${base}//seat-${id}`, agentUid: euid };
        const refused = (await rejects(() => reapSeat(root, id, { cgroup: dotted }))) && (await rejects(() => reapSeat(root, id, { cgroup: doubled }))) &&
          throws(() => checkSeatRelease(root, id, { cgroup: dotted })) && (await rejects(() => sealSeatLaunch(root, id, { cgroup: doubled })));
        check("bounds: reap and release reject a `..` or non-normalized seat cgroup path and leave the seat populated",
          refused && seatCgroupPopulated({ path: real, agentUid: euid }) && !fenceSealed(id));
        break;
      }
      case "wrong-base": {
        // A normalized seat cgroup under a sibling, not this process's base, names no seat of ours.
        const id = seatId();
        const sibling = `${base}/x/seat-${id}`;
        mkdirSync(sibling, { recursive: true });
        const cg = { path: sibling, agentUid: euid };
        const rejected = (await reapSeat(root, id, { cgroup: cg }).then(() => false, () => true)) &&
          (() => {
            try {
              checkSeatRelease(root, id, { cgroup: cg });
              return false;
            } catch {
              return true;
            }
          })() &&
          (await sealSeatLaunch(root, id, { cgroup: cg }).then(() => false, () => true));
        check("wrong base: reap, check and seal reject a normalized seat cgroup under a sibling base and leave it",
          rejected && existsSync(sibling) && !fenceSealed(id), { rejected, sibling: existsSync(sibling) });
        rmdirSync(sibling);
        rmdirSync(dirname(sibling));
        break;
      }
      default:
        throw new Error(`unknown cell ${String(cell)}`);
    }
  } finally {
    // Only seat cgroups this cell created under its own fresh scope are ever killed.
    for (const path of created) {
      if (!existsSync(path)) continue;
      try {
        writeFileSync(join(path, "cgroup.kill"), "1");
        await until(() => !/^populated 1$/m.test(readOr(join(path, "cgroup.events"), "")), 5_000);
        removeSeatCgroup({ path, agentUid });
      } catch (e) {
        console.log(`    cleanup of ${path} failed: ${(e as Error).message}`);
      }
    }
    for (const owned of strays) killOwned(owned);
    rmSync(root, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
  console.log(`CELL_TALLY ${JSON.stringify({ pass, fail, skipped })}`);
}
