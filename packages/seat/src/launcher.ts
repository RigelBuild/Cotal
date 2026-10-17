import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSeatId, capabilityToken, fencePath, readSeatFileNoFollow, recordPath, seatId, socketPath, type SeatRecord, readRecord } from "./record.js";
import { CONFIRM_TIMEOUT_MS, unattendedMs, assertSocketPathFits, unsupportedTransport } from "./protocol.js";
import { tryLockFd } from "./peercred.js";
import type { CustodianTestSeam } from "./custodian.js";
import { agentPrimaryGid, createSeatCgroup, moveIntoSeatCgroup, ownCgroup, removeSeatCgroup, trustedSetpriv, type SeatCgroup } from "./cgroup.js";

export interface SeatLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  confirm?: string;
}

export interface LaunchSeatOpts {
  root: string;
  name: string;
  spec: SeatLaunchSpec;
  cwd: string;
  /** A custody id the caller minted BEFORE this launch, so a durable record of the seat can exist
   *  before its processes do. Omitted mints one here, as before. It names a directory under
   *  `root`, so it must carry the seat-id shape and must not already hold a record. */
  id?: string;
  /** Layer 3: the manager's delegated cgroup. The seat cgroup `<base>/seat-<id>` must not exist yet;
   *  the custodian is moved into it and spawns no child outside it. */
  cgroupBase?: string;
  /** The uid the custodian and its child run as. Omitted is this process's euid. A distinct uid needs
   *  euid 0: the seat directory is chowned to it and the custodian is spawned with its uid and gid. */
  agentUid?: number;
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Always the compiled entry. tsx loading `src/` must not spawn a missing `src/custodian.js`. */
function custodianEntry(): string {
  const path = join(packageRoot(), "dist", "custodian.js");
  if (!existsSync(path)) throw new Error(`custodian entry missing at ${path}; build @cotal-ai/seat first`);
  return path;
}

/**
 * The RUN this launch belongs to, as an argv marker a census can read straight out of
 * `/proc/<pid>/cmdline` (#1648).
 *
 * Orphan custodians carried the worktree path only as their cwd, so finding them meant walking
 * `/proc/*\/cwd`, which needs the right uid for every pid on the box and cannot say WHICH run left
 * one behind. `COTAL_RUN` names the run when a caller sets it (a suite runner, a CI job); otherwise
 * the launching process's own pid names it, which is still enough to tell one run's orphans from
 * another's. It goes on ARGV, not only in the environment: `/proc/<pid>/cmdline` is world-readable
 * while `/proc/<pid>/environ` is readable by the owner alone, so argv is the half a census can rely
 * on. It carries no secret: the launch JSON (token, provider keys) still arrives on stdin.
 */
export const RUN_MARKER_FLAG = "--cotal-run";

/** This process's parent, from `/proc/<pid>/stat` field 4. Undefined when the pid is gone. */
function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `COTAL_RUN` as the nearest ancestor set it, when this process no longer has it.
 *
 * A suite that builds a child environment scrubs every `COTAL_` key, which is the correct rule for
 * connection material and takes `COTAL_RUN` with it. The run is then invisible to the launcher, the
 * marker degrades to this process's pid, and the runner's census cannot attribute the custodian to
 * the run that started it. Measured: a child spawned through that scrub reported
 * `child_saw_COTAL_RUN: null` and `claimed_by_run_census: false`.
 *
 * The environment of an ancestor still has it, because the scrub copies rather than edits the
 * parent. `/proc/<pid>/environ` is readable by its owner, and every process in this chain belongs to
 * the same uid, so a short walk recovers the run without weakening the scrub or asking every suite
 * to remember an exception. Bounded to 16 hops so a pathological chain cannot spin, and it stops at
 * pid 1, which owns no run.
 */
function inheritedRun(startPid: number): string | undefined {
  let pid = parentOf(startPid);
  for (let hop = 0; hop < 16 && pid !== undefined; hop++) {
    try {
      const entry = readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .find((s) => s.startsWith("COTAL_RUN="));
      const value = entry?.slice("COTAL_RUN=".length).trim();
      if (value) return value;
    } catch {
      // Not ours to read, or it exited mid-walk. Keep climbing: a readable ancestor may be further up.
    }
    pid = parentOf(pid);
  }
  return undefined;
}

export function runMarker(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
  const named = env.COTAL_RUN?.trim() ?? (env === process.env ? inheritedRun(pid) : undefined);
  // Newlines and spaces would split one marker into two argv-looking tokens in a census.
  return named ? named.replace(/\s+/g, "_") : `pid-${pid}`;
}

/** The run marker carried by a live custodian, read back from its argv. Undefined when that pid is
 *  not a custodian started with one. This is the read side of {@link runMarker}: the census a
 *  reaper takes is this call over the pids it is considering. */
export function runMarkerOf(pid: number): string | undefined {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
  const argv = cmdline.split("\0").filter((s) => s.length > 0);
  const at = argv.indexOf(RUN_MARKER_FLAG);
  if (at < 0) return undefined;
  return argv[at + 1];
}

function pidLive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

// Test seams: index.ts does not re-export these and the package `exports` map names only ".", so an
// installed consumer cannot reach them.
let testSeam: CustodianTestSeam | undefined;
export function setCustodianTestSeam(seam: CustodianTestSeam | undefined): void {
  testSeam = seam;
}

/** `afterFence`: pause after creating the fence, before its lock. `failMkdir`: throw at the seat mkdir.
 *  `beforeMove`: pause after spawning the custodian, before moving it into the seat cgroup.
 *  `failMove`: throw in place of that move. */
export interface LauncherTestSeam {
  afterFence?: { reached: string; release: string };
  failMkdir?: boolean;
  beforeMove?: { reached: string; release: string };
  failMove?: boolean;
}
let launcherSeam: LauncherTestSeam | undefined;
export function setLauncherTestSeam(seam: LauncherTestSeam | undefined): void {
  launcherSeam = seam;
}

// launchSeat is synchronous, so the hold sleeps in a child rather than on this event loop.
function holdLauncher(hold: { reached: string; release: string }): void {
  writeFileSync(hold.reached, String(process.pid));
  const holdBy = Date.now() + CONFIRM_TIMEOUT_MS;
  while (!existsSync(hold.release)) {
    if (Date.now() >= holdBy) throw new Error("test seam launcher hold was never released");
    spawnSync("sleep", ["0.025"], { stdio: "ignore" });
  }
}

export function launchSeat(opts: LaunchSeatOpts): SeatRecord {
  const created: { cgroup?: SeatCgroup } = {};
  try {
    return launchInto(opts, created);
  } catch (e) {
    // rmdir only, never a kill: an empty cgroup goes, so a pending custodian finds it gone and exits.
    if (created.cgroup) {
      try {
        removeSeatCgroup(created.cgroup);
      } catch (rm) {
        const code = (rm as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EBUSY") throw rm;
      }
    }
    throw e;
  }
}

function launchInto(opts: LaunchSeatOpts, created: { cgroup?: SeatCgroup }): SeatRecord {
  if (process.platform !== "linux") throw unsupportedTransport();
  const euid = process.geteuid?.() ?? -1;
  const agentUid = opts.agentUid ?? euid;
  if (!Number.isInteger(agentUid) || agentUid < 0) throw new Error(`agent uid ${agentUid} is not a uid`);
  let agent: { uid: number; gid: number } | undefined;
  if (agentUid !== euid) {
    if (euid !== 0) throw new Error(`a seat under agent uid ${agentUid} needs a manager with euid 0, not ${euid}`);
    const gid = agentPrimaryGid(agentUid);
    if (gid === undefined) throw new Error(`agent uid ${agentUid} is not in /etc/passwd and COTAL_SEAT_AGENT_GID names no gid`);
    agent = { uid: agentUid, gid };
  }
  // An agent that can never gain a capability cannot bypass the seat cgroup's mode bits, which is what
  // makes a reap provable. No trusted setpriv means no distinct-uid seat at all.
  const setpriv = agent ? trustedSetpriv() : undefined;
  if (agent && !setpriv) throw new Error("no root-owned setpriv: refusing to launch a seat under a distinct agent uid without no_new_privs");
  mkdirSync(opts.root, { recursive: true, mode: 0o700 });
  // The agent must reach its own seat directory and the fence; 0711 lets it traverse, not list.
  if (agent) chmodSync(opts.root, 0o711);
  const id = assertSeatId(opts.id ?? seatId());
  const token = capabilityToken();
  const socket = assertSocketPathFits(socketPath(opts.root, id));
  const recPath = recordPath(opts.root, id);
  // A reserved id is spawned once. Reusing one would launch a second custodian over a live seat's
  // record, and the reference the manager already recorded would then address the wrong processes.
  if (existsSync(recPath)) throw new Error(`seat ${id} already holds a custody record at ${recPath}; a custody id is used for one launch`);
  const fence = fencePath(opts.root, id);
  // `wx+` (O_CREAT|O_EXCL, read-write): an existing fence is an id an earlier launch or release used.
  const fenceFd = openSync(fence, "wx+", 0o644);
  let cgroup: SeatCgroup | undefined;
  let launchFd: number | undefined;
  const logPath = join(dirname(recPath), "custodian.log");
  const run = runMarker();
  try {
    const hold = launcherSeam?.afterFence;
    if (hold) holdLauncher(hold);
    const lockDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (!tryLockFd(fenceFd)) {
      if (Date.now() >= lockDeadline) throw new Error(`seat ${id} launch fence ${fence} stayed locked for ${CONFIRM_TIMEOUT_MS}ms; refusing to create the seat`);
      spawnSync("sleep", ["0.025"], { stdio: "ignore" });
    }
    if (readFileSync(fenceFd, "utf8").trim() === "sealed") throw new Error(`seat ${id} launch fence ${fence} is sealed; the seat was released`);
    if (launcherSeam?.failMkdir) throw new Error("test seam: seat mkdir failed");
    // Under the fence lock, so a release that sealed first leaves no cgroup to create.
    if (opts.cgroupBase !== undefined) {
      // A reap or release derives the path from its own base, so a seat under any other base is unreapable.
      if (opts.cgroupBase !== ownCgroup()) throw new Error(`cgroup base ${opts.cgroupBase} is not this process's cgroup ${String(ownCgroup())}`);
      cgroup = created.cgroup = createSeatCgroup(opts.cgroupBase, id, agentUid);
    }
    mkdirSync(dirname(recPath), { mode: 0o700 });
    const payload = JSON.stringify({
      id,
      name: opts.name,
      command: opts.spec.command,
      args: opts.spec.args,
      env: opts.spec.env ?? {},
      cwd: opts.cwd,
      socket,
      token,
      recordPath: recPath,
      fence,
      logPath,
      confirm: opts.spec.confirm,
      run,
      // Resolved HERE, not in the custodian: the custodian's environment is scrubbed to `PATH` plus the
      // run marker, so it cannot read an override the caller set.
      unattendedMs: unattendedMs(),
      ...(cgroup ? { cgroup: cgroup.path } : {}),
      adopterUid: euid,
      ...(testSeam ? { testSeam } : {}),
    });
    // Payload carries spec.env (provider keys) and the capability token.
    // argv is world-readable via /proc/<pid>/cmdline (0444). Inherit a 0600
    // file as stdin so the JSON never appears on argv.
    //
    // The run marker is the one thing deliberately ON argv, because that is the point of it: a census
    // must be able to attribute an orphan without the uid needed to read `/proc/<pid>/cwd`. It names a
    // run, never a credential.
    // Written, opened and unlinked while the seat directory is still ours: after the chown below the
    // agent owns it and could plant a link here. Exclusive and no-follow regardless.
    const launchPath = join(dirname(recPath), "launch.json");
    const writeFd = openSync(launchPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(writeFd, payload);
    } finally {
      closeSync(writeFd);
    }
    launchFd = openSync(launchPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    unlinkSync(launchPath);
    if (agent) chownSync(dirname(recPath), agent.uid, agent.gid);
  } catch (e) {
    if (launchFd !== undefined) closeSync(launchFd);
    throw e;
  } finally {
    closeSync(fenceFd);
  }
  const custodianArgv = [process.execPath, custodianEntry(), RUN_MARKER_FLAG, run];
  const argv = agent && setpriv
    ? [setpriv, "--reuid", String(agent.uid), "--regid", String(agent.gid), "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--", ...custodianArgv]
    : custodianArgv;
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    detached: true,
    stdio: [launchFd, "ignore", "ignore"],
    // COTAL_RUN is re-exported so a custodian's own descendants stay attributable to the same run,
    // and so `/proc/<pid>/environ` answers the same question argv does for a reader who can read it.
    env: { PATH: process.env.PATH ?? "", COTAL_RUN: run },
  });
  closeSync(launchFd);
  child.unref();
  if (cgroup) {
    const hold = launcherSeam?.beforeMove;
    if (hold) holdLauncher(hold);
    // A reap or release that removed the empty cgroup first makes this throw ENOENT; the custodian
    // then sees the cgroup gone and exits with no child.
    if (child.pid === undefined) throw new Error("custodian spawn returned no pid; no seat cgroup move");
    if (launcherSeam?.failMove) throw new Error("test seam: seat cgroup move failed");
    moveIntoSeatCgroup(cgroup, child.pid);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const rec = readRecord(recPath);
      if (rec.custodianPid > 0 && rec.childPid > 0) {
        // The record is agent-writable: the id, socket and token this launch generated win over its copies.
        return { ...rec, id, socket, token };
      }
    } catch {
      /* record not written yet */
    }
    if (!pidLive(child.pid)) {
      let err = "";
      try {
        err = readSeatFileNoFollow(logPath).trim();
      } catch {
        /* no log */
      }
      throw new Error(`custodian exited before ready: ${err || `pid ${String(child.pid)} gone`}`);
    }
    spawnSync("sleep", ["0.025"], { stdio: "ignore" });
  }
  throw new Error(`custodian did not write a seat record at ${recPath}`);
}

/** The record of seat `id`, with its socket derived from the root and id. The seat directory may be
 *  owned by the agent uid, so a record naming another seat, or another socket, is not trusted. */
export function loadSeat(root: string, id: string): SeatRecord {
  const rec = readRecord(recordPath(root, id));
  if (rec.id !== id) throw new Error(`seat record at ${recordPath(root, id)} names seat ${rec.id}, not ${id}; refusing to adopt it`);
  return { ...rec, socket: socketPath(root, id) };
}

export function readSeatFile(path: string): SeatRecord {
  return JSON.parse(readFileSync(path, "utf8")) as SeatRecord;
}
